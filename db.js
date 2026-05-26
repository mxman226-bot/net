// =====================================================
// db.js — Firebase data layer (Auth + Firestore + Storage)
// Transactions, realtime listeners, history, recycle bin
// =====================================================
import { auth, db, storage } from "./firebase.js"
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js"
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  onSnapshot, collection, getDocs, query, where, orderBy, limit,
  serverTimestamp, runTransaction, addDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"
import {
  ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js"

const phoneToEmail = (phone) => `${phone}@chem-platform.app`

/* ============================================================
   AUTH
============================================================ */
export async function registerUser({ name, phone, pass, stage }) {
  const email = phoneToEmail(phone)
  const cred = await createUserWithEmailAndPassword(auth, email, pass)
  const uid = cred.user.uid
  const userData = {
    uid, name, phone, stage,
    balance: 0,
    unlocked: {},
    progress: {},
    createdAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
  }
  await setDoc(doc(db, "users", uid), userData)
  return userData
}

export async function loginUser({ phone, pass }) {
  const email = phoneToEmail(phone)
  const cred = await signInWithEmailAndPassword(auth, email, pass)
  const snap = await getDoc(doc(db, "users", cred.user.uid))
  // touch lastActiveAt (non-blocking)
  updateDoc(doc(db, "users", cred.user.uid), { lastActiveAt: serverTimestamp() }).catch(() => {})
  return snap.exists() ? snap.data() : null
}

export async function logoutUser() {
  await signOut(auth)
}

/** auto-login watcher */
export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) return callback(null)
    try {
      const snap = await getDoc(doc(db, "users", firebaseUser.uid))
      callback(snap.exists() ? snap.data() : null)
    } catch (e) {
      console.log("[v0] watchAuth error", e)
      callback(null)
    }
  })
}

/** realtime user doc subscription */
export function subscribeUser(uid, callback) {
  return onSnapshot(doc(db, "users", uid), (snap) => {
    if (snap.exists()) callback(snap.data())
  })
}

export async function getUser(uid) {
  const snap = await getDoc(doc(db, "users", uid))
  return snap.exists() ? snap.data() : null
}

/* ============================================================
   WALLET — atomic transactions + history
============================================================ */

/** Server-trusted transaction: deduct price + unlock session in one atomic op */
export async function purchaseSession(uid, key, price) {
  const userRef = doc(db, "users", uid)
  const txRef = doc(collection(db, "users", uid, "transactions"))
  return await runTransaction(db, async (t) => {
    const snap = await t.get(userRef)
    if (!snap.exists()) throw new Error("user_not_found")
    const u = snap.data()
    if (u.unlocked && u.unlocked[key]) {
      return { ok: true, already: true, balance: u.balance || 0 }
    }
    const bal = u.balance || 0
    if (bal < price) return { ok: false, balance: bal }
    const newBal = bal - price
    t.update(userRef, {
      balance: newBal,
      [`unlocked.${key}`]: true,
    })
    t.set(txRef, {
      type: "purchase",
      sessionKey: key,
      amount: -price,
      balanceBefore: bal,
      balanceAfter: newBal,
      createdAt: serverTimestamp(),
    })
    return { ok: true, balance: newBal }
  })
}

/** Atomic recharge by admin (or system). Keeps transaction history. */
export async function adminAddBalance(phone, amount, adminUid = null) {
  const q = query(collection(db, "users"), where("phone", "==", phone))
  const snap = await getDocs(q)
  if (snap.empty) return null
  const userDoc = snap.docs[0]
  const userRef = userDoc.ref
  const txRef = doc(collection(userRef, "transactions"))
  return await runTransaction(db, async (t) => {
    const fresh = await t.get(userRef)
    if (!fresh.exists()) return null
    const data = fresh.data()
    const bal = data.balance || 0
    const newBal = bal + amount
    t.update(userRef, { balance: newBal })
    t.set(txRef, {
      type: amount >= 0 ? "recharge" : "deduction",
      amount,
      balanceBefore: bal,
      balanceAfter: newBal,
      adminUid,
      createdAt: serverTimestamp(),
    })
    return { ...data, balance: newBal, _txId: txRef.id }
  })
}

/** Undo the last balance transaction (admin-only). */
export async function undoLastTransaction(uid) {
  const txCol = collection(db, "users", uid, "transactions")
  const q = query(txCol, orderBy("createdAt", "desc"), limit(1))
  const snap = await getDocs(q)
  if (snap.empty) return { ok: false, reason: "no_tx" }
  const last = snap.docs[0]
  const tx = last.data()
  if (tx.reverted) return { ok: false, reason: "already_reverted" }
  const userRef = doc(db, "users", uid)
  return await runTransaction(db, async (t) => {
    const u = await t.get(userRef)
    if (!u.exists()) return { ok: false }
    const bal = u.data().balance || 0
    const restored = bal - tx.amount // reverse the delta
    t.update(userRef, { balance: restored })
    t.update(last.ref, { reverted: true, revertedAt: serverTimestamp() })
    // also re-lock session if it was a purchase
    if (tx.type === "purchase" && tx.sessionKey) {
      t.update(userRef, { [`unlocked.${tx.sessionKey}`]: false })
    }
    return { ok: true, balance: restored }
  })
}

export function subscribeTransactions(uid, callback) {
  const txCol = collection(db, "users", uid, "transactions")
  const q = query(txCol, orderBy("createdAt", "desc"), limit(30))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  })
}

/** Code-based unlock (atomic, also records a tx) */
export async function unlockSessionWithCode(uid, key) {
  const userRef = doc(db, "users", uid)
  const txRef = doc(collection(userRef, "transactions"))
  await runTransaction(db, async (t) => {
    const snap = await t.get(userRef)
    if (!snap.exists()) throw new Error("user_not_found")
    const u = snap.data()
    if (u.unlocked && u.unlocked[key]) return
    t.update(userRef, { [`unlocked.${key}`]: true })
    t.set(txRef, {
      type: "code_unlock",
      sessionKey: key,
      amount: 0,
      balanceBefore: u.balance || 0,
      balanceAfter: u.balance || 0,
      createdAt: serverTimestamp(),
    })
  })
}

/* ============================================================
   ADMIN — students, realtime, recycle bin
============================================================ */
export function subscribeStudents(callback) {
  const q = query(collection(db, "users"), orderBy("createdAt", "desc"))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => d.data()))
  }, (err) => console.log("[v0] subscribeStudents error", err))
}

/** Soft-delete: move user doc to deletedUsers/, then remove from users/ */
export async function softDeleteUser(uid, adminUid = null) {
  const userRef = doc(db, "users", uid)
  const snap = await getDoc(userRef)
  if (!snap.exists()) return false
  const data = snap.data()
  await setDoc(doc(db, "deletedUsers", uid), {
    ...data,
    deletedAt: serverTimestamp(),
    deletedBy: adminUid,
  })
  await deleteDoc(userRef)
  return true
}

export async function restoreDeletedUser(uid) {
  const ref = doc(db, "deletedUsers", uid)
  const snap = await getDoc(ref)
  if (!snap.exists()) return false
  const data = snap.data()
  delete data.deletedAt
  delete data.deletedBy
  await setDoc(doc(db, "users", uid), data)
  await deleteDoc(ref)
  return true
}

export async function permanentlyDeleteUser(uid) {
  await deleteDoc(doc(db, "deletedUsers", uid))
  return true
}

export function subscribeDeletedUsers(callback) {
  const q = query(collection(db, "deletedUsers"), orderBy("deletedAt", "desc"))
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  })
}

/* ============================================================
   SESSIONS (lessons)
============================================================ */
export async function getAllSessions() {
  const snap = await getDocs(collection(db, "sessions"))
  const out = {}
  snap.forEach((d) => { out[d.id] = d.data() })
  return out
}

export function subscribeSessions(callback) {
  return onSnapshot(collection(db, "sessions"), (snap) => {
    const out = {}
    snap.forEach((d) => { out[d.id] = d.data() })
    callback(out)
  })
}

export async function getSession(key) {
  const snap = await getDoc(doc(db, "sessions", key))
  return snap.exists() ? snap.data() : {}
}

export async function setSession(key, data) {
  await setDoc(doc(db, "sessions", key), { ...data, updatedAt: serverTimestamp() }, { merge: true })
}

/* ============================================================
   PROGRESS — continue watching
============================================================ */
export async function setProgress(uid, key, percent) {
  await updateDoc(doc(db, "users", uid), {
    [`progress.${key}`]: { percent, updatedAt: Date.now() },
  })
}

/* ============================================================
   CONFIG
============================================================ */
const CONF_DOC = "main"
const DEFAULT_CONFIG = { master: "123456", adminPw: "admin123", price: 50 }

export async function getConfig() {
  const snap = await getDoc(doc(db, "config", CONF_DOC))
  if (!snap.exists()) {
    await setDoc(doc(db, "config", CONF_DOC), DEFAULT_CONFIG)
    return { ...DEFAULT_CONFIG }
  }
  return { ...DEFAULT_CONFIG, ...snap.data() }
}

export async function saveConfig(cfg) {
  await setDoc(doc(db, "config", CONF_DOC), cfg, { merge: true })
}

export function subscribeConfig(callback) {
  return onSnapshot(doc(db, "config", CONF_DOC), (snap) => {
    if (snap.exists()) callback({ ...DEFAULT_CONFIG, ...snap.data() })
  })
}

/* ============================================================
   ADMIN ROLE
============================================================ */
export async function isAdminUid(uid) {
  if (!uid) return false
  try {
    const snap = await getDoc(doc(db, "admins", uid))
    return snap.exists() && snap.data().admin === true
  } catch (e) {
    console.log("[v0] isAdminUid error", e)
    return false
  }
}

export async function grantAdmin(uid) {
  await setDoc(doc(db, "admins", uid), { admin: true, grantedAt: serverTimestamp() })
}

/* ============================================================
   STORAGE — video upload
============================================================ */
export function uploadLessonVideo(key, file, onProgress) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("no_file"))
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
    const path = `lessons/${key}/${Date.now()}_${safe}`
    const ref = sRef(storage, path)
    const task = uploadBytesResumable(ref, file, { contentType: file.type || "video/mp4" })
    task.on("state_changed",
      (s) => onProgress && onProgress((s.bytesTransferred / s.totalBytes) * 100),
      (err) => reject(err),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref)
          resolve({ url, path })
        } catch (e) { reject(e) }
      },
    )
  })
}

export async function deleteLessonVideoByPath(path) {
  if (!path) return
  try { await deleteObject(sRef(storage, path)) }
  catch (e) { console.log("[v0] deleteLessonVideo error", e) }
}

/* ============================================================
   QUIZZES
============================================================ */
export async function getQuiz(key) {
  const snap = await getDoc(doc(db, "quizzes", key))
  return snap.exists() ? snap.data() : null
}

export async function setQuiz(key, data) {
  await setDoc(doc(db, "quizzes", key), { ...data, updatedAt: serverTimestamp() }, { merge: true })
}

export async function saveQuizResult(uid, key, { score, total, answers }) {
  const ref = doc(collection(db, "users", uid, "quizResults"))
  await setDoc(ref, {
    quizKey: key,
    score, total,
    percent: total ? Math.round((score / total) * 100) : 0,
    answers,
    createdAt: serverTimestamp(),
  })
  // also store best/last on user doc for quick access
  await updateDoc(doc(db, "users", uid), {
    [`quizScores.${key}`]: { score, total, percent: total ? Math.round((score / total) * 100) : 0, at: Date.now() },
  })
}

export function subscribeQuizResults(uid, callback) {
  const q = query(collection(db, "users", uid, "quizResults"), orderBy("createdAt", "desc"), limit(50))
  return onSnapshot(q, (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))))
}
