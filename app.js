// =========================================================
// app.js — Chemistry platform main orchestrator
// =========================================================
import {
  registerUser, loginUser, logoutUser, watchAuth, subscribeUser, getUser,
  purchaseSession, unlockSessionWithCode,
  subscribeStudents, adminAddBalance, undoLastTransaction,
  softDeleteUser, restoreDeletedUser, permanentlyDeleteUser, subscribeDeletedUsers,
  getAllSessions, subscribeSessions, getSession, setSession,
  getConfig, saveConfig, subscribeConfig,
  uploadLessonVideo,
  getQuiz, setQuiz, saveQuizResult,
  setProgress,
  subscribeTransactions,
} from "/db.js"

/* =====================================================
   STATE
===================================================== */
const ALL_CLASSES = [
  "الأول الإعدادي", "الثاني الإعدادي", "الثالث الإعدادي",
  "الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي",
]
const SESSIONS_PER_CLASS = 10

const state = {
  user: null,
  uid: null,
  config: { master: "123456", adminPw: "admin123", price: 50 },
  sessionsCache: {},
  navStack: [],
  currentClass: "",
  currentPending: null,
  adminLoggedIn: false,
  adminClass: ALL_CLASSES[0],
  adminQuizClass: ALL_CLASSES[0],
  lock: { attempts: 0, until: 0 },
  unsubs: { user: null, students: null, sessions: null, config: null, bin: null, tx: null },
  quiz: null, // { key, questions, idx, answers }
}

/* =====================================================
   DOM HELPERS
===================================================== */
const $ = (id) => document.getElementById(id)
const $$ = (sel, root = document) => root.querySelectorAll(sel)

function openModal(id) { const el = $(id); if (el) el.classList.add("open") }
function closeModal(id) { const el = $(id); if (el) el.classList.remove("open") }

function setBtnLoading(btn, loading) {
  if (!btn) return
  if (loading) { btn.classList.add("loading"); btn.disabled = true }
  else { btn.classList.remove("loading"); btn.disabled = false }
}

/* =====================================================
   TOAST
===================================================== */
let toastTimer = null
function toast(msg, kind = "ok") {
  const t = $("toast")
  if (!t) return
  const map = { true: "ok", false: "err" }
  const cls = typeof kind === "boolean" ? (kind ? "ok" : "err") : kind
  t.className = "toast " + cls
  t.innerText = msg
  t.classList.add("show")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600)
}

/* =====================================================
   CONFIRM DIALOG (promise-based)
===================================================== */
let confirmResolve = null
function confirmDialog({ title = "تأكيد", text = "", icon = "⚠️", danger = true } = {}) {
  return new Promise((resolve) => {
    confirmResolve = resolve
    $("confirmTitle").innerText = title
    $("confirmText").innerText = text
    $("confirmIcon").innerText = icon
    const btn = $("confirmYes")
    btn.classList.toggle("btn-red", !!danger)
    btn.classList.toggle("btn-gold", !danger)
    openModal("confirmModal")
  })
}
function resolveConfirm(value) {
  if (confirmResolve) { confirmResolve(value); confirmResolve = null }
  closeModal("confirmModal")
}

/* =====================================================
   VALIDATION
===================================================== */
const sanitize = (s) => String(s).replace(/[<>"'`]/g, "").trim()
function setHint(id, msg, kind) {
  const el = $(id); if (!el) return
  el.className = "field-hint" + (kind ? " " + kind : "")
  el.innerHTML = msg
    ? `<i class="fas fa-${kind === "ok" ? "check-circle" : kind === "bad" ? "times-circle" : "info-circle"}"></i> ${msg}`
    : ""
}
function validatePhone(input, hintId) {
  input.value = input.value.replace(/[^0-9]/g, "")
  const v = input.value
  input.classList.remove("error")
  if (!v) { setHint(hintId, "", ""); return false }
  if (v.length < 11) { setHint(hintId, `${v.length}/11 رقم`, ""); return false }
  if (!/^01[0-9]{9}$/.test(v)) { setHint(hintId, "رقم غير صحيح", "bad"); input.classList.add("error"); return false }
  setHint(hintId, "رقم صحيح", "ok"); return true
}
function validatePass(input, hintId) {
  const v = input.value
  input.classList.remove("error")
  if (!v) { setHint(hintId, "", ""); return false }
  if (v.length < 6) { setHint(hintId, `كلمة السر قصيرة (${v.length}/6)`, "bad"); return false }
  setHint(hintId, "كلمة سر مناسبة", "ok"); return true
}
function validateName(input, hintId) {
  const v = input.value.trim()
  input.classList.remove("error")
  if (!v) { setHint(hintId, "", ""); return false }
  if (v.length < 3) { setHint(hintId, "الاسم قصير", "bad"); return false }
  setHint(hintId, "تمام", "ok"); return true
}

/* =====================================================
   NAV
===================================================== */
function goTo(id, push = true) {
  const screens = $$(".screen")
  const cur = [...screens].find((s) => s.classList.contains("active"))
  if (push && cur) state.navStack.push(cur.id)
  screens.forEach((s) => s.classList.remove("active"))
  $(id).classList.add("active")
  window.scrollTo({ top: 0, behavior: "smooth" })
}

/* =====================================================
   AUTH TABS
===================================================== */
function moveTabIndicator(activeTab, container = "authTabs") {
  const ind = container === "authTabs" ? $("tabIndicator") : null
  if (!ind) return
  const rect = activeTab.getBoundingClientRect()
  const parentRect = activeTab.parentElement.getBoundingClientRect()
  ind.style.width = rect.width + "px"
  ind.style.right = (rect.right - parentRect.right) * -1 + "px"
}
function switchAuthTab(tab) {
  $$("#authTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab))
  const active = document.querySelector(`#authTabs .tab[data-tab="${tab}"]`)
  if (active) moveTabIndicator(active)
  $("loginForm").classList.toggle("is-hidden", tab !== "login")
  $("registerForm").classList.toggle("is-hidden", tab !== "register")
}

/* =====================================================
   SPLASH
===================================================== */
function hideSplash() {
  const el = $("splash")
  if (!el) return
  el.classList.add("hide")
  setTimeout(() => el.remove(), 380)
}

/* =====================================================
   AUTH FLOW
===================================================== */
async function doLogin(e) {
  e?.preventDefault?.()
  const phoneInp = $("l-phone"), passInp = $("l-pass")
  const phone = sanitize(phoneInp.value), pass = passInp.value.trim()
  if (!phone || !pass) {
    phoneInp.classList.toggle("error", !phone); passInp.classList.toggle("error", !pass)
    return toast("أدخل رقم الموبايل وكلمة السر", false)
  }
  if (!/^01[0-9]{9}$/.test(phone)) { phoneInp.classList.add("error"); return toast("رقم الموبايل غير صحيح", false) }

  const btn = $("loginBtn"); setBtnLoading(btn, true)
  try {
    const u = await loginUser({ phone, pass })
    if (!u) { phoneInp.classList.add("error"); throw new Error("no_user") }
    toast("أهلاً بيك " + u.name + " 👋", true)
    // watchAuth will fire and call afterLogin
  } catch (err) {
    console.log("[v0] login error", err.code || err.message)
    const code = err.code || ""
    if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
      passInp.classList.add("error"); toast("كلمة السر غلط!", false)
    } else if (code === "auth/user-not-found" || code === "auth/invalid-login-credentials") {
      phoneInp.classList.add("error"); toast("الرقم ده مش موجود — أنشئ حساب أولاً", false)
    } else if (code === "auth/too-many-requests") {
      toast("محاولات كتير، حاول بعد شوية", false)
    } else { toast("تعذر تسجيل الدخول، حاول تاني", false) }
  } finally { setBtnLoading(btn, false) }
}

async function doRegister(e) {
  e?.preventDefault?.()
  const nameInp = $("r-name"), phoneInp = $("r-phone"), passInp = $("r-pass"), stageEl = $("r-stage")
  const name = sanitize(nameInp.value), phone = sanitize(phoneInp.value)
  const pass = passInp.value.trim(), stage = stageEl.value
  if (!name || !phone || !pass || !stage) {
    nameInp.classList.toggle("error", !name); phoneInp.classList.toggle("error", !phone); passInp.classList.toggle("error", !pass)
    return toast("أكمل كل البيانات", false)
  }
  if (!/^01[0-9]{9}$/.test(phone)) { phoneInp.classList.add("error"); return toast("رقم الموبايل غير صحيح", false) }
  if (pass.length < 6) { passInp.classList.add("error"); return toast("كلمة السر 6 أحرف على الأقل", false) }
  if (name.length < 3) { nameInp.classList.add("error"); return toast("أدخل اسمك الكامل", false) }

  const btn = $("regBtn"); setBtnLoading(btn, true)
  try {
    await registerUser({ name, phone, pass, stage })
    toast("تم إنشاء الحساب بنجاح 🎉", true)
  } catch (err) {
    console.log("[v0] register error", err.code || err.message)
    if (err.code === "auth/email-already-in-use") {
      phoneInp.classList.add("error")
      switchAuthTab("login")
      $("l-phone").value = phone
      validatePhone($("l-phone"), "l-phone-hint")
      toast("الرقم ده مسجل قبل كده، سجّل دخولك", false)
    } else if (err.code === "auth/weak-password") {
      passInp.classList.add("error"); toast("كلمة السر ضعيفة", false)
    } else { toast("تعذر إنشاء الحساب، حاول تاني", false) }
  } finally { setBtnLoading(btn, false) }
}

function afterLogin() {
  const u = state.user
  $("profileSection").hidden = false
  $("profileNameText").innerText = u.name || ""
  $("profileStageText").innerText = u.stage || "بدون مرحلة"
  $("profilePhone").innerText = u.phone || ""
  $("profileAv").innerText = (u.name || "?").charAt(0)
  refreshBalUI()
  renderMainCard()
  renderContinueWatching()
  goTo("s-main", false)
}

function refreshBalUI() {
  const el = $("balDisp"); if (el && state.user) el.innerText = (state.user.balance || 0) + " جنيه"
}

async function doLogout() {
  try { await logoutUser() } catch (e) { console.log("[v0] logout error", e) }
  cleanupUserSubs()
  state.user = null; state.uid = null
  $("profileSection").hidden = true
  state.navStack = []
  switchAuthTab("login");
  ["l-phone", "l-pass", "r-name", "r-phone", "r-pass"].forEach((i) => { const el = $(i); if (el) el.value = "" });
  ["l-phone-hint", "r-phone-hint", "r-pass-hint", "r-name-hint"].forEach((i) => setHint(i, "", ""))
  goTo("s-login", false)
}

function cleanupUserSubs() {
  ["user", "tx"].forEach((k) => { if (state.unsubs[k]) { state.unsubs[k](); state.unsubs[k] = null } })
}

/* =====================================================
   MAIN SCREEN
===================================================== */
function renderMainCard() {
  const stage = state.user.stage || ""
  const isPrep = stage.includes("الإعدادي"); const isSec = stage.includes("الثانوي")
  const icon = isPrep ? "🧪" : isSec ? "🔬" : "📚"
  $("mainWelcomeTitle").innerText = stage || "حصصك الدراسية"
  $("mainWelcomeSub").innerText = "اضغط للدخول على حصصك"
  const wrap = $("mainClassCard"); wrap.innerHTML = ""
  if (!stage) {
    wrap.innerHTML = `<div class="admin-prompt">⚠️ لم يتم تحديد المرحلة الدراسية<br>تواصل مع الأستاذ</div>`
    return
  }
  const d = document.createElement("div")
  d.className = "stage-card"
  d.innerHTML = `
    <div class="stage-icon">${icon}</div>
    <div class="stage-info">
      <h3>${escapeHtml(stage)}</h3>
      <p>اضغط لعرض حصصك</p>
    </div>
    <i class="fas fa-chevron-left c-teal" aria-hidden="true"></i>`
  d.addEventListener("click", () => openClass(stage))
  wrap.appendChild(d)
}

function renderContinueWatching() {
  const wrap = $("continueWatching")
  const prog = state.user?.progress || {}
  const items = Object.entries(prog)
    .filter(([, v]) => v && v.percent > 0 && v.percent < 95)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 6)
  if (!items.length) { wrap.hidden = true; wrap.innerHTML = ""; return }
  wrap.hidden = false
  wrap.innerHTML = `<div style="font-size:.78rem;font-weight:800;color:var(--muted);margin:0 4px 6px">تابع المشاهدة</div>`
  const row = document.createElement("div")
  row.style.display = "flex"; row.style.gap = "10px"; row.style.overflowX = "auto"
  items.forEach(([key, p]) => {
    const [cls, num] = key.split("-")
    const card = document.createElement("div")
    card.className = "continue-card"
    card.innerHTML = `
      <div class="thumb">
        <div class="bar"><i style="width:${p.percent}%"></i></div>
      </div>
      <div class="ttl">${escapeHtml(cls)}</div>
      <div class="meta">الحصة ${num} • ${p.percent}%</div>`
    card.addEventListener("click", () => openClass(cls))
    row.appendChild(card)
  })
  wrap.appendChild(row)
}

/* =====================================================
   LESSONS LIST
===================================================== */
let currentLessonFilter = "all"
let currentLessonSearch = ""

async function openClass(className) {
  state.currentClass = className
  $("classTitle").innerText = className
  // ensure caches
  if (!state.sessionsCache || !Object.keys(state.sessionsCache).length) {
    state.sessionsCache = await getAllSessions().catch(() => ({}))
  }
  refreshBalUI()
  renderLessonStats()
  renderLessons()
  goTo("s-details")
}

function renderLessonStats() {
  const className = state.currentClass
  const total = SESSIONS_PER_CLASS
  let unl = 0
  for (let i = 1; i <= total; i++) if (state.user.unlocked && state.user.unlocked[`${className}-${i}`]) unl++
  $("statsRow").innerHTML = `
    <div class="stat"><div class="val">${total}</div><div class="lbl">إجمالي الحصص</div></div>
    <div class="stat"><div class="val c-teal">${unl}</div><div class="lbl">حصص مفعّلة</div></div>
    <div class="stat"><div class="val" style="color:var(--muted)">${total - unl}</div><div class="lbl">حصص مغلقة</div></div>`
}

function renderLessons() {
  const className = state.currentClass
  const wrap = $("sessionsList"); wrap.innerHTML = ""
  const bal = state.user.balance || 0
  const price = state.config.price || 50
  let shown = 0
  for (let i = 1; i <= SESSIONS_PER_CLASS; i++) {
    const key = `${className}-${i}`
    const isUnl = !!(state.user.unlocked && state.user.unlocked[key])
    if (currentLessonFilter === "unlocked" && !isUnl) continue
    if (currentLessonFilter === "locked" && isUnl) continue
    const titleQuery = currentLessonSearch.trim()
    const titleStr = `الحصة رقم ${i} ${className}`
    if (titleQuery && !titleStr.includes(titleQuery)) continue

    const sess = state.sessionsCache[key] || {}
    const thumb = sess.thumb || ""
    const progress = (state.user.progress && state.user.progress[key]?.percent) || 0
    const card = document.createElement("article")
    card.className = `session-card${isUnl ? " unlocked" : ""}`
    card.style.animationDelay = `${Math.min(shown, 5) * 0.04}s`
    card.innerHTML = `
      <div class="sess-thumb${thumb ? "" : " placeholder"}">
        ${thumb ? `<img data-lazy="${escapeAttr(thumb)}" alt="">` : `<i class="fas fa-flask" aria-hidden="true"></i>`}
        <span class="num-pill">${i}</span>
        ${isUnl ? `<i class="fas fa-play play-ico"></i>` : `<span class="lock-ico"><i class="fas fa-lock"></i></span>`}
        ${progress > 0 ? `<div class="sess-progress"><div class="bar" style="width:${progress}%"></div></div>` : ""}
      </div>
      <div class="sess-head">
        <div class="sess-head-left">
          <div class="sess-num">${i}</div>
          <span class="sess-title">الحصة رقم ${i}</span>
        </div>
        <div class="status-badge ${isUnl ? "status-unlocked" : "status-locked"}">
          ${isUnl ? '<i class="fas fa-check-circle"></i> مفعّلة' : '<i class="fas fa-lock"></i> مغلقة'}
        </div>
      </div>
      <div class="action-row">
        <button class="action-btn btn-video" type="button" data-act="video" data-num="${i}"><i class="fas fa-play"></i> الشرح</button>
        <button class="action-btn btn-hw" type="button" data-act="homework" data-num="${i}"><i class="fas fa-file-pdf"></i> التدريب</button>
        <button class="action-btn btn-test" type="button" data-act="test" data-num="${i}"><i class="fas fa-pen-nib"></i> الاختبار</button>
        <button class="action-btn btn-quiz" type="button" data-act="quiz" data-num="${i}"><i class="fas fa-question"></i> أسئلة</button>
      </div>
      ${!isUnl ? `<button class="btn-buy" type="button" data-act="buy" data-num="${i}">
        <i class="fas fa-coins"></i> شراء الحصة بالرصيد — ${price} جنيه <span style="opacity:.7;font-size:.72rem">(رصيدك: ${bal} ج)</span>
      </button>` : ""}`
    wrap.appendChild(card)
    shown++
  }
  if (!shown) wrap.innerHTML = `<div class="admin-prompt">لا توجد حصص مطابقة للبحث.</div>`
  observeLazyImages(wrap)
}

/* IntersectionObserver for thumbs */
let lazyIO = null
function observeLazyImages(root) {
  if (!("IntersectionObserver" in window)) {
    root.querySelectorAll("img[data-lazy]").forEach((img) => { img.src = img.dataset.lazy; img.addEventListener("load", () => img.classList.add("loaded")) })
    return
  }
  if (!lazyIO) {
    lazyIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          const img = e.target
          img.src = img.dataset.lazy
          img.removeAttribute("data-lazy")
          img.addEventListener("load", () => img.classList.add("loaded"), { once: true })
          lazyIO.unobserve(img)
        }
      })
    }, { rootMargin: "200px 0px" })
  }
  root.querySelectorAll("img[data-lazy]").forEach((img) => lazyIO.observe(img))
}

/* =====================================================
   PURCHASE / UNLOCK / OPEN
===================================================== */
async function initBuyWithBalance(num) {
  if (!state.uid) return
  const cls = state.currentClass
  const fresh = await getUser(state.uid).catch(() => null)
  if (fresh) state.user = fresh
  refreshBalUI()
  state.config = await getConfig().catch(() => state.config)
  const price = state.config.price || 50
  const bal = state.user.balance || 0
  state.currentPending = { cls, num, type: null }
  $("confirmSessName").innerText = `${cls} — الحصة ${num}`
  $("confirmDetails").innerHTML = `
    <div class="row"><span style="color:var(--muted)">سعر الحصة</span><strong class="c-gold">${price} جنيه</strong></div>
    <div class="row"><span style="color:var(--muted)">رصيدك الحالي</span><strong style="color:${bal >= price ? "var(--teal)" : "var(--red)"}">${bal} جنيه</strong></div>
    <div class="sep"></div>
    <div class="row"><span style="color:var(--muted)">الرصيد بعد الشراء</span>
      <strong style="color:${bal >= price ? "var(--teal)" : "var(--red)"}">${bal >= price ? bal - price + " جنيه" : "غير كافي"}</strong>
    </div>`
  openModal("confirmBuyModal")
}

async function confirmBuyWithBalance(btn) {
  if (!state.currentPending || !state.uid) return
  setBtnLoading(btn, true)
  try {
    state.config = await getConfig().catch(() => state.config)
    const price = state.config.price || 50
    const { cls, num } = state.currentPending
    const key = `${cls}-${num}`
    const result = await purchaseSession(state.uid, key, price)
    if (!result.ok) {
      closeModal("confirmBuyModal")
      return toast(`رصيدك ${result.balance} ج — تحتاج ${price} ج. اشحن الرصيد!`, false)
    }
    closeModal("confirmBuyModal")
    if (result.already) toast("الحصة دي مفعّلة أصلاً", true)
    else toast(`✅ تم الشراء وتفعيل الحصة!`, true)
    // realtime listener will refresh user; force re-render of stats
    setTimeout(() => { renderLessonStats(); renderLessons() }, 250)
  } catch (e) {
    console.log("[v0] purchase error", e); toast("حدث خطأ في الشراء", false)
  } finally { setBtnLoading(btn, false) }
}

async function handleAction(num, type) {
  if (!state.uid) return
  const cls = state.currentClass
  const key = `${cls}-${num}`
  if (state.user.unlocked && state.user.unlocked[key]) {
    if (type === "quiz") return openQuiz(key)
    return openSessionLink(key, type)
  }
  state.currentPending = { cls, num, type }
  $("unlockSessName").innerText = `${cls} — الحصة ${num}`
  $("codeInput").value = ""
  openModal("unlockModal")
  setTimeout(() => $("codeInput").focus(), 250)
}

async function verifyCode() {
  const raw = $("codeInput").value.trim()
  const code = raw.replace(/[^a-zA-Z0-9]/g, "")
  if (!code) return toast("أدخل الكود أولاً", false)
  const { cls, num, type } = state.currentPending
  const key = `${cls}-${num}`
  state.config = await getConfig().catch(() => state.config)
  const sess = await getSession(key).catch(() => ({}))
  const master = (state.config.master || "").trim()
  const sessCode = (sess.code || "").trim()
  if (code === master || (sessCode && code === sessCode)) {
    try {
      await unlockSessionWithCode(state.uid, key)
      closeModal("unlockModal"); toast("✅ تم التفعيل بنجاح!", true)
      setTimeout(() => {
        renderLessonStats(); renderLessons()
        if (type === "quiz") openQuiz(key)
        else openSessionLink(key, type)
      }, 250)
    } catch (e) { console.log("[v0] code unlock error", e); toast("حدث خطأ", false) }
  } else {
    const inp = $("codeInput"); inp.style.borderColor = "var(--red)"
    inp.style.boxShadow = "0 0 0 3px rgba(255,71,87,0.15)"
    setTimeout(() => { inp.style.borderColor = ""; inp.style.boxShadow = "" }, 600)
    toast("الكود غير صحيح!", false)
  }
}

async function openSessionLink(key, type) {
  const fresh = await getUser(state.uid).catch(() => null)
  if (!fresh) return toast("أعد تسجيل الدخول", false)
  if (!fresh.unlocked || !fresh.unlocked[key]) return toast("الحصة غير مفعّلة", false)
  const data = await getSession(key).catch(() => ({}))
  if (!data || !data[type]) return toast("الرابط غير متوفر حالياً", false)
  if (type === "video") return openVideoModal(key, data.video)
  window.open(data[type], "_blank", "noopener,noreferrer")
}

/* =====================================================
   VIDEO MODAL (lazy, no autoplay)
===================================================== */
function getEmbedUrl(url) {
  if (!url) return null
  // YouTube
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/)
  if (m) return { type: "iframe", src: `https://www.youtube.com/embed/${m[1]}?rel=0` }
  // Google Drive
  m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/)
  if (m) return { type: "iframe", src: `https://drive.google.com/file/d/${m[1]}/preview` }
  // Bunny / direct mp4
  if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) return { type: "video", src: url }
  // Generic iframe
  return { type: "iframe", src: url }
}

function openVideoModal(key, url) {
  const embed = getEmbedUrl(url)
  if (!embed) return toast("الرابط غير صحيح", false)
  $("videoTitle").innerText = key.replace("-", " — الحصة ")
  const frame = $("videoFrame")
  frame.innerHTML = ""
  if (embed.type === "iframe") {
    const iframe = document.createElement("iframe")
    iframe.src = embed.src
    iframe.loading = "lazy"
    iframe.allow = "accelerometer; encrypted-media; picture-in-picture"
    iframe.allowFullscreen = true
    frame.appendChild(iframe)
  } else {
    const video = document.createElement("video")
    video.src = embed.src; video.controls = true; video.preload = "metadata"; video.playsInline = true
    video.addEventListener("timeupdate", () => {
      if (!video.duration) return
      const pct = Math.round((video.currentTime / video.duration) * 100)
      if (pct % 5 === 0 && state.uid) setProgress(state.uid, key, pct).catch(() => {})
    })
    frame.appendChild(video)
  }
  openModal("videoModal")
}
function closeVideoModal() { $("videoFrame").innerHTML = ""; closeModal("videoModal") }

/* =====================================================
   QUIZZES
===================================================== */
async function openQuiz(key) {
  const data = await getQuiz(key)
  if (!data || !data.questions || !data.questions.length) {
    return toast("لا يوجد اختبار لهذه الحصة بعد", false)
  }
  state.quiz = { key, title: data.title || "اختبار " + key, questions: data.questions, idx: 0, answers: [], score: 0 }
  $("quizTitle").innerText = state.quiz.title
  openModal("quizModal")
  renderQuizStep()
}

function renderQuizStep() {
  const q = state.quiz
  if (!q) return
  if (q.idx >= q.questions.length) return finishQuiz()
  const cur = q.questions[q.idx]
  $("quizMeta").innerText = `سؤال ${q.idx + 1}/${q.questions.length}`
  $("quizProgressBar").style.width = `${(q.idx / q.questions.length) * 100}%`
  $("quizNextBtn").querySelector(".btn-label").innerHTML = q.idx === q.questions.length - 1
    ? `إنهاء <i class="fas fa-check"></i>` : `التالي <i class="fas fa-arrow-left"></i>`
  const body = $("quizBody")
  body.innerHTML = `<div class="quiz-q">${escapeHtml(cur.q)}</div><div class="quiz-options" id="quizOpts"></div>`
  const opts = $("quizOpts")
  cur.options.forEach((opt, i) => {
    const b = document.createElement("button")
    b.className = "quiz-opt"; b.type = "button"
    b.innerText = opt
    b.addEventListener("click", () => {
      $$(".quiz-opt", opts).forEach((x) => x.classList.remove("selected"))
      b.classList.add("selected")
      q.tempAnswer = i
    })
    opts.appendChild(b)
  })
  q.tempAnswer = null
}

function nextQuizStep() {
  const q = state.quiz; if (!q) return
  if (q.tempAnswer == null) return toast("اختر إجابة أولاً", false)
  const cur = q.questions[q.idx]
  const correct = q.tempAnswer === cur.correct
  if (correct) q.score++
  q.answers.push({ q: cur.q, picked: q.tempAnswer, correct: cur.correct, isCorrect: correct })
  q.idx++
  renderQuizStep()
}

async function finishQuiz() {
  const q = state.quiz; if (!q) return
  $("quizProgressBar").style.width = "100%"
  $("quizMeta").innerText = "النتيجة"
  const pct = Math.round((q.score / q.questions.length) * 100)
  $("quizBody").innerHTML = `
    <div class="quiz-result">
      <div class="score">${q.score} / ${q.questions.length}</div>
      <div class="label">نسبة النجاح ${pct}%</div>
    </div>`
  $("quizNextBtn").querySelector(".btn-label").innerHTML = `إغلاق <i class="fas fa-times"></i>`
  $("quizNextBtn").onclick = () => { closeModal("quizModal"); $("quizNextBtn").onclick = nextQuizStep }
  try { if (state.uid) await saveQuizResult(state.uid, q.key, { score: q.score, total: q.questions.length, answers: q.answers }) }
  catch (e) { console.log("[v0] saveQuizResult error", e) }
  state.quiz = null
}

/* =====================================================
   TRANSACTIONS MODAL
===================================================== */
function openTxModal() {
  if (!state.uid) return
  const list = $("txList"); list.innerHTML = `<div class="tx-empty">جارٍ التحميل…</div>`
  openModal("txModal")
  if (state.unsubs.tx) state.unsubs.tx()
  state.unsubs.tx = subscribeTransactions(state.uid, (rows) => {
    if (!rows.length) { list.innerHTML = `<div class="tx-empty">لا توجد معاملات بعد</div>`; return }
    list.innerHTML = ""
    rows.forEach((tx) => {
      const isPos = tx.amount > 0, isNeg = tx.amount < 0
      const ico = tx.type === "purchase" ? "fa-cart-shopping" : tx.type === "recharge" ? "fa-wallet" : tx.type === "code_unlock" ? "fa-key" : "fa-arrow-right-arrow-left"
      const label = tx.type === "purchase" ? `شراء حصة ${tx.sessionKey || ""}` :
        tx.type === "recharge" ? "شحن رصيد" :
        tx.type === "code_unlock" ? `تفعيل بكود ${tx.sessionKey || ""}` :
        tx.type === "deduction" ? "خصم من الرصيد" : "معاملة"
      const dt = tx.createdAt?.toDate ? tx.createdAt.toDate() : null
      const meta = dt ? dt.toLocaleString("ar-EG") : ""
      const reverted = tx.reverted ? ` • <span class="c-red">ملغاة</span>` : ""
      const row = document.createElement("div"); row.className = "tx-row"
      row.innerHTML = `
        <div class="ico ${isPos ? "pos" : isNeg ? "neg" : "neu"}"><i class="fas ${ico}"></i></div>
        <div class="info">
          <div class="ttl">${escapeHtml(label)}</div>
          <div class="meta">${meta}${reverted}</div>
        </div>
        <div class="amt ${isPos ? "pos" : isNeg ? "neg" : ""}">${tx.amount > 0 ? "+" : ""}${tx.amount} ج</div>`
      list.appendChild(row)
    })
  })
}

/* =====================================================
   ADMIN
===================================================== */
function openAdmin() {
  openModal("adminModal")
  if (!state.adminLoggedIn) {
    $("adminLoginSec").hidden = false
    $("adminContent").hidden = true
    $("adminPassInput").value = ""
    $("adminLockMsg").hidden = true
    setTimeout(() => $("adminPassInput").focus(), 250)
  }
}

async function doAdminLogin() {
  if (state.lock.until > Date.now()) {
    const mins = Math.ceil((state.lock.until - Date.now()) / 60000)
    $("adminLockMsg").hidden = false
    $("adminLockMsg").innerText = `🔒 محظور لمدة ${mins} دقيقة بسبب محاولات متكررة`
    return
  }
  state.config = await getConfig().catch(() => state.config)
  const v = $("adminPassInput").value
  if (v === state.config.adminPw) {
    state.adminLoggedIn = true
    state.lock = { attempts: 0, until: 0 }
    $("adminLoginSec").hidden = true
    $("adminContent").hidden = false
    $("sMaster").value = state.config.master || ""
    $("sAdminPw").value = state.config.adminPw || ""
    $("sPrice").value = state.config.price || 50
    startAdminSubs()
    renderAdminClsBtns(); renderAdminSessions(state.adminClass)
    renderAdminQuizClsBtns(); renderAdminQuizzes(state.adminQuizClass)
  } else {
    state.lock.attempts = (state.lock.attempts || 0) + 1
    if (state.lock.attempts >= 5) {
      state.lock.until = Date.now() + 10 * 60 * 1000
      $("adminLockMsg").hidden = false
      $("adminLockMsg").innerText = "🔒 تم قفل اللوحة 10 دقائق"
    } else { toast(`كود المسؤول غلط (${5 - state.lock.attempts} محاولات متبقية)`, false) }
  }
}

let allStudents = []
let allDeleted = []
function startAdminSubs() {
  if (state.unsubs.students) state.unsubs.students()
  state.unsubs.students = subscribeStudents((list) => {
    allStudents = list
    renderStudents()
  })
  if (state.unsubs.bin) state.unsubs.bin()
  state.unsubs.bin = subscribeDeletedUsers((list) => {
    allDeleted = list
    renderBin()
  })
  if (state.unsubs.sessions) state.unsubs.sessions()
  state.unsubs.sessions = subscribeSessions((s) => {
    state.sessionsCache = s
    if ($("atab-sessions") && !$("atab-sessions").hidden) renderAdminSessions(state.adminClass)
  })
}

function renderStudents() {
  const filter = $("studentSearch")?.value?.trim() || ""
  const list = filter
    ? allStudents.filter((u) => (u.name || "").includes(filter) || (u.phone || "").includes(filter))
    : allStudents
  $("totalStudents").innerText = allStudents.length
  const wrap = $("studentsList")
  wrap.innerHTML = ""
  if (!list.length) { wrap.innerHTML = `<div class="admin-prompt">لا يوجد طلاب${filter ? " بهذا البحث" : ""}.</div>`; return }
  list.forEach((u) => {
    const unl = u.unlocked ? Object.keys(u.unlocked).filter((k) => u.unlocked[k]).length : 0
    const row = document.createElement("div"); row.className = "student-row"
    row.innerHTML = `
      <div class="avatar">${(u.name || "?").charAt(0)}</div>
      <div class="info">
        <div class="sname">${escapeHtml(u.name || "")}</div>
        <div class="smeta">${escapeHtml(u.phone || "")} • ${escapeHtml(u.stage || "")} • ${unl} حصص</div>
      </div>
      <div class="student-bal">${u.balance || 0} ج</div>
      <div class="row-actions">
        <button class="add-bal-btn btn-sm-teal" type="button" data-charge="${u.phone}" data-amt="50">+50</button>
        <button class="add-bal-btn btn-sm-gold" type="button" data-charge="${u.phone}" data-amt="100">+100</button>
        <button class="add-bal-btn btn-sm-undo" type="button" data-undo="${u.uid}" title="إلغاء آخر معاملة"><i class="fas fa-rotate-left"></i></button>
        <button class="add-bal-btn btn-sm-red" type="button" data-delete="${u.uid}" data-name="${escapeAttr(u.name || "")}" title="حذف"><i class="fas fa-trash"></i></button>
      </div>`
    wrap.appendChild(row)
  })
}

function renderBin() {
  const wrap = $("binList"); wrap.innerHTML = ""
  if (!allDeleted.length) { wrap.innerHTML = `<div class="admin-prompt">سلة المحذوفات فارغة.</div>`; return }
  allDeleted.forEach((u) => {
    const row = document.createElement("div"); row.className = "student-row"
    row.innerHTML = `
      <div class="avatar" style="background:linear-gradient(135deg,#6b8fa8,#3a4f5e)">${(u.name || "?").charAt(0)}</div>
      <div class="info">
        <div class="sname">${escapeHtml(u.name || "")}</div>
        <div class="smeta">${escapeHtml(u.phone || "")} • ${escapeHtml(u.stage || "")}</div>
      </div>
      <div class="row-actions">
        <button class="add-bal-btn btn-sm-teal" type="button" data-restore="${u.id}"><i class="fas fa-rotate-left"></i> استرجاع</button>
        <button class="add-bal-btn btn-sm-red" type="button" data-purge="${u.id}" data-name="${escapeAttr(u.name || "")}"><i class="fas fa-trash"></i> حذف نهائي</button>
      </div>`
    wrap.appendChild(row)
  })
}

async function adminCharge(phone, amount) {
  if (!state.adminLoggedIn) { toast("غير مصرح", false); return }
  try {
    const updated = await adminAddBalance(phone, amount, state.uid)
    if (!updated) return toast("الطالب مش موجود", false)
    toast(`✅ تمت إضافة ${amount} ج لـ ${updated.name}`, true)
  } catch (e) { console.log("[v0] charge error", e); toast("حدث خطأ", false) }
}

async function adminCustomCharge() {
  if (!state.adminLoggedIn) { toast("غير مصرح", false); return }
  const phone = $("customPhone").value.trim()
  const amount = parseInt($("customAmount").value)
  if (!phone) return toast("أدخل رقم الطالب", false)
  if (!amount || amount === 0) return toast("أدخل مبلغ صحيح", false)
  if (Math.abs(amount) > 5000) return toast("الحد الأقصى 5000 ج في المرة", false)
  await adminCharge(phone, amount)
  $("customPhone").value = ""; $("customAmount").value = ""
}

async function doUndoLastTx(uid) {
  if (!state.adminLoggedIn) return
  const ok = await confirmDialog({ title: "إلغاء آخر معاملة", text: "هذا سيعكس آخر شحنة أو شراء لهذا الطالب.", icon: "↩️", danger: false })
  if (!ok) return
  try {
    const r = await undoLastTransaction(uid)
    if (!r.ok) toast(r.reason === "no_tx" ? "لا توجد معاملات" : "لا يمكن الإلغاء", false)
    else toast(`✅ تم الإلغاء، الرصيد الحالي ${r.balance} ج`, true)
  } catch (e) { console.log("[v0] undo error", e); toast("حدث خطأ", false) }
}

async function doSoftDelete(uid, name) {
  if (!state.adminLoggedIn) return
  const ok = await confirmDialog({ title: "حذف الطالب", text: `سيتم نقل ${name || "الطالب"} إلى سلة المحذوفات. يمكن استرجاعه.`, icon: "🗑️", danger: true })
  if (!ok) return
  try {
    await softDeleteUser(uid, state.uid)
    toast("✅ تم الحذف (يمكن الاسترجاع من سلة المحذوفات)", true)
  } catch (e) { console.log("[v0] delete error", e); toast("حدث خطأ", false) }
}

async function doRestore(uid) {
  try { await restoreDeletedUser(uid); toast("✅ تم الاسترجاع", true) }
  catch (e) { console.log("[v0] restore error", e); toast("حدث خطأ", false) }
}

async function doPurge(uid, name) {
  const ok = await confirmDialog({ title: "حذف نهائي", text: `حذف ${name || "الطالب"} نهائياً من قاعدة البيانات. لا يمكن التراجع.`, icon: "⚠️", danger: true })
  if (!ok) return
  try { await permanentlyDeleteUser(uid); toast("✅ تم الحذف نهائياً", true) }
  catch (e) { console.log("[v0] purge error", e); toast("حدث خطأ", false) }
}

/* admin: sessions */
function renderAdminClsBtns() {
  const wrap = $("adminClsBtns"); wrap.innerHTML = ""
  ALL_CLASSES.forEach((cls) => {
    const b = document.createElement("button"); b.type = "button"
    b.className = "cls-btn" + (cls === state.adminClass ? " active" : "")
    b.innerText = cls
    b.addEventListener("click", () => { state.adminClass = cls; renderAdminClsBtns(); renderAdminSessions(cls) })
    wrap.appendChild(b)
  })
}

function renderAdminSessions(cls) {
  if (!state.adminLoggedIn) return
  const sessDB = state.sessionsCache
  const wrap = $("adminSessList"); wrap.innerHTML = ""
  for (let i = 1; i <= SESSIONS_PER_CLASS; i++) {
    const key = `${cls}-${i}`
    const d = sessDB[key] || { code: "", video: "", homework: "", test: "", thumb: "" }
    const div = document.createElement("div")
    div.className = "sess-editor"
    div.innerHTML = `
      <div class="sess-editor-title">
        <span>الحصة ${i}</span>
        <button type="button" class="btn-teal" data-save-sess="${key}"><i class="fas fa-save"></i> حفظ</button>
      </div>
      <div class="sess-editor-grid">
        <div><div class="mini-label">🔑 الكود</div><input id="sc-${key}" class="mini-input mono-input c-teal" value="${escapeAttr(d.code || "")}" maxlength="10" placeholder="000000"></div>
        <div><div class="mini-label">🖼️ ثمب نيل (رابط صورة)</div><input id="sth-${key}" class="mini-input" value="${escapeAttr(d.thumb || "")}" placeholder="https://…/thumb.jpg"></div>
        <div class="full"><div class="mini-label">🎬 رابط الشرح (YouTube/Drive/MP4)</div><input id="sv-${key}" class="mini-input" value="${escapeAttr(d.video || "")}" placeholder="https://youtu.be/…"></div>
        <div class="full">
          <div class="upload-row">
            <label class="upload-btn"><i class="fas fa-upload"></i> رفع فيديو
              <input type="file" accept="video/*" data-upload="${key}" hidden>
            </label>
            <div class="upload-progress" id="up-${key}"><div class="bar"></div></div>
          </div>
        </div>
        <div><div class="mini-label">📄 رابط التدريب</div><input id="sh-${key}" class="mini-input" value="${escapeAttr(d.homework || "")}" placeholder="https://drive.google.com/…"></div>
        <div><div class="mini-label">✏️ رابط الاختبار</div><input id="st-${key}" class="mini-input" value="${escapeAttr(d.test || "")}" placeholder="https://forms.google.com/…"></div>
      </div>`
    wrap.appendChild(div)
  }
}

async function saveSessionData(key) {
  if (!state.adminLoggedIn) { toast("غير مصرح", false); return }
  const video = $(`sv-${key}`).value.trim()
  const homework = $(`sh-${key}`).value.trim()
  const test = $(`st-${key}`).value.trim()
  const thumb = $(`sth-${key}`).value.trim()
  const code = $(`sc-${key}`).value.trim()
  const validUrl = (u) => !u || /^https?:\/\//.test(u)
  if (![video, homework, test, thumb].every(validUrl)) return toast("الروابط يجب أن تبدأ بـ https://", false)
  try {
    await setSession(key, { code, video, homework, test, thumb })
    state.sessionsCache[key] = { code, video, homework, test, thumb }
    toast("✅ تم الحفظ", true)
  } catch (e) { console.log("[v0] saveSession error", e); toast("حدث خطأ", false) }
}

async function uploadSessionVideo(key, file) {
  if (!state.adminLoggedIn) { toast("غير مصرح", false); return }
  if (!file) return
  if (file.size > 500 * 1024 * 1024) return toast("الملف كبير جداً (> 500MB)", false)
  const wrap = $(`up-${key}`); wrap.classList.add("show")
  const bar = wrap.querySelector(".bar")
  try {
    const { url, path } = await uploadLessonVideo(key, file, (pct) => { bar.style.width = pct + "%" })
    $(`sv-${key}`).value = url
    await setSession(key, { video: url, videoPath: path })
    state.sessionsCache[key] = { ...(state.sessionsCache[key] || {}), video: url, videoPath: path }
    toast("✅ تم رفع الفيديو", true)
  } catch (e) { console.log("[v0] upload error", e); toast("فشل رفع الفيديو", false) }
  finally { setTimeout(() => { wrap.classList.remove("show"); bar.style.width = "0%" }, 600) }
}

/* admin: quizzes */
function renderAdminQuizClsBtns() {
  const wrap = $("adminQuizClsBtns"); wrap.innerHTML = ""
  ALL_CLASSES.forEach((cls) => {
    const b = document.createElement("button"); b.type = "button"
    b.className = "cls-btn" + (cls === state.adminQuizClass ? " active" : "")
    b.innerText = cls
    b.addEventListener("click", () => { state.adminQuizClass = cls; renderAdminQuizClsBtns(); renderAdminQuizzes(cls) })
    wrap.appendChild(b)
  })
}

async function renderAdminQuizzes(cls) {
  const wrap = $("adminQuizList"); wrap.innerHTML = `<div class="admin-prompt">جارٍ التحميل…</div>`
  const items = []
  for (let i = 1; i <= SESSIONS_PER_CLASS; i++) {
    const key = `${cls}-${i}`
    const data = await getQuiz(key).catch(() => null)
    items.push({ key, data })
  }
  wrap.innerHTML = ""
  items.forEach(({ key, data }) => {
    const i = key.split("-")[1]
    const json = data ? JSON.stringify({ title: data.title || "", questions: data.questions || [] }, null, 2) : `{
  "title": "اختبار الحصة ${i}",
  "questions": [
    { "q": "ما هو الرمز الكيميائي للماء؟", "options": ["H2O", "CO2", "O2", "NaCl"], "correct": 0 }
  ]
}`
    const div = document.createElement("div"); div.className = "sess-editor"
    div.innerHTML = `
      <div class="sess-editor-title">
        <span>اختبار الحصة ${i}</span>
        <button type="button" class="btn-teal" data-save-quiz="${key}"><i class="fas fa-save"></i> حفظ</button>
      </div>
      <textarea id="qj-${key}" class="mini-input" rows="6" style="resize:vertical;font-family:ui-monospace,monospace;direction:ltr;text-align:left;font-size:.78rem;line-height:1.5">${escapeHtml(json)}</textarea>`
    wrap.appendChild(div)
  })
}

async function saveQuizFromEditor(key) {
  if (!state.adminLoggedIn) { toast("غير مصرح", false); return }
  try {
    const raw = $(`qj-${key}`).value
    const parsed = JSON.parse(raw)
    if (!parsed.questions || !Array.isArray(parsed.questions)) throw new Error("bad format")
    parsed.questions.forEach((q) => {
      if (!q.q || !Array.isArray(q.options) || typeof q.correct !== "number") throw new Error("bad question")
    })
    await setQuiz(key, parsed)
    toast("✅ تم حفظ الاختبار", true)
  } catch (e) {
    console.log("[v0] save quiz error", e)
    toast("صيغة JSON غير صحيحة", false)
  }
}

/* admin: tabs + settings */
function switchAdminTab(tab) {
  $$("#adminTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.atab === tab));
  ["students", "sessions", "quizzes", "bin", "settings"].forEach((t) => {
    const el = $("atab-" + t); if (el) el.hidden = t !== tab
  })
}

async function saveAdminSettings() {
  if (!state.adminLoggedIn) { toast("غير مصرح", false); return }
  const master = $("sMaster").value.trim().replace(/[^a-zA-Z0-9]/g, "")
  const adminPw = $("sAdminPw").value.trim()
  const price = parseInt($("sPrice").value) || 50
  if (!master || !adminPw) return toast("لا تترك الحقول فارغة", false)
  if (master.length < 4) return toast("الكود السحري 4 أحرف على الأقل", false)
  if (adminPw.length < 4) return toast("كود المسؤول 4 أحرف على الأقل", false)
  if (price < 1 || price > 1000) return toast("السعر بين 1 و 1000", false)
  try {
    await saveConfig({ master, adminPw, price })
    state.config = { master, adminPw, price }
    toast("✅ تم حفظ الإعدادات", true)
  } catch (e) { console.log("[v0] save config error", e); toast("حدث خطأ", false) }
}

/* =====================================================
   RECHARGE
===================================================== */
async function openRecharge() {
  if (state.user) $("senderInfo").value = `${state.user.name} — ${state.user.phone}`
  state.config = await getConfig().catch(() => state.config)
  const price = state.config.price || 50
  $("priceHint").innerText = `سعر الحصة ${price} ج`
  updateWaLink()
  openModal("rechargeModal")
}
function updateWaLink() {
  const sender = ($("senderInfo")?.value || "").trim()
  const amount = ($("transferAmount")?.value || "").trim()
  let msg = "🔬 السلام عليكم أستاذ محمد أيمن،\nأنا حولت رصيد عشان أشحن حسابي على منصة الكيمياء 💳\n\n"
  msg += `👤 *المرسل:* ${sender || "(لم يُدخل بعد)"}\n`
  msg += `👨‍🏫 *المرسل إليه:* أ/ محمد أيمن — 01273132014\n`
  if (amount) msg += `💰 *المبلغ:* ${amount} جنيه\n`
  msg += "\nلو سمحت شحن الرصيد في حسابي، شكراً! 🙏"
  const link = $("waLink"); if (link) link.href = `https://wa.me/201273132014?text=${encodeURIComponent(msg)}`
}
function validateRecharge(e) {
  const sender = ($("senderInfo").value || "").trim()
  const amount = ($("transferAmount").value || "").trim()
  if (!sender) { toast("اكتب اسمك ورقمك أولاً", false); e?.preventDefault?.(); return false }
  if (!amount || parseInt(amount) < 1) { toast("اكتب المبلغ اللي حولته", false); e?.preventDefault?.(); return false }
  updateWaLink(); return true
}

/* =====================================================
   UTILITIES
===================================================== */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]) }
function escapeAttr(s) { return escapeHtml(s) }
function copyNum(num) {
  navigator.clipboard?.writeText(num).then(() => toast("✅ تم نسخ الرقم!", true)).catch(() => toast("الرقم: " + num, "info"))
}

/* =====================================================
   GLOBAL EVENT DELEGATION
===================================================== */
function bindEvents() {
  /* auth tabs */
  $("authTabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab"); if (!t) return
    switchAuthTab(t.dataset.tab)
  })

  /* login/register forms */
  $("loginForm").addEventListener("submit", doLogin)
  $("registerForm").addEventListener("submit", doRegister)

  /* live validation */
  document.addEventListener("input", (e) => {
    const t = e.target
    if (!t.dataset?.validate) return
    const hintId = (t.id || "") + "-hint"
    if (t.dataset.validate === "phone") validatePhone(t, hintId)
    else if (t.dataset.validate === "pass") validatePass(t, hintId)
    else if (t.dataset.validate === "name") validateName(t, hintId)
  })

  /* pw toggle */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".pw-toggle"); if (!btn) return
    const id = btn.dataset.pw; const inp = $(id); const icon = btn.querySelector("i")
    if (inp.type === "password") { inp.type = "text"; icon.className = "fas fa-eye-slash" }
    else { inp.type = "password"; icon.className = "fas fa-eye" }
  })

  /* data-action buttons */
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]"); if (!el) return
    const a = el.dataset.action
    if (a === "logout") doLogout()
    else if (a === "open-recharge" || a === "open-recharge-from-confirm") {
      if (a === "open-recharge-from-confirm") closeModal("confirmBuyModal")
      openRecharge()
    }
    else if (a === "open-tx") openTxModal()
    else if (a === "open-admin") openAdmin()
    else if (a === "admin-login") doAdminLogin()
    else if (a === "admin-custom-charge") adminCustomCharge()
    else if (a === "save-admin-settings") saveAdminSettings()
    else if (a === "go-main") goTo("s-main")
    else if (a === "verify-code") verifyCode()
    else if (a === "confirm-buy") confirmBuyWithBalance(el)
  })

  /* data-close (modal close) */
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-close]"); if (!el) return
    closeModal(el.dataset.close)
    if (el.dataset.close === "videoModal") $("videoFrame").innerHTML = ""
    if (el.dataset.close === "confirmModal") resolveConfirm(false)
    if (el.dataset.close === "txModal" && state.unsubs.tx) { state.unsubs.tx(); state.unsubs.tx = null }
  })

  /* backdrop close */
  $$(".modal-bg[data-close-on-backdrop]").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m) {
        m.classList.remove("open")
        if (m.id === "videoModal") $("videoFrame").innerHTML = ""
        if (m.id === "confirmModal") resolveConfirm(false)
        if (m.id === "txModal" && state.unsubs.tx) { state.unsubs.tx(); state.unsubs.tx = null }
      }
    })
  })

  /* confirm dialog */
  $("confirmYes").addEventListener("click", () => resolveConfirm(true))

  /* lessons screen actions (delegated) */
  $("sessionsList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]"); if (!btn) return
    const num = parseInt(btn.dataset.num); const act = btn.dataset.act
    if (act === "buy") return initBuyWithBalance(num)
    handleAction(num, act)
  })

  /* search + filters */
  $("lessonSearch").addEventListener("input", (e) => { currentLessonSearch = e.target.value; renderLessons() })
  $("filterPills").addEventListener("click", (e) => {
    const p = e.target.closest(".pill"); if (!p) return
    $$("#filterPills .pill").forEach((x) => x.classList.toggle("active", x === p))
    currentLessonFilter = p.dataset.filter; renderLessons()
  })

  /* admin tabs */
  $("adminTabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab"); if (!t) return
    switchAdminTab(t.dataset.atab)
  })

  /* admin students search */
  $("studentSearch").addEventListener("input", () => renderStudents())

  /* admin students list actions (delegated) */
  $("studentsList").addEventListener("click", (e) => {
    const charge = e.target.closest("[data-charge]")
    if (charge) return adminCharge(charge.dataset.charge, parseInt(charge.dataset.amt))
    const undo = e.target.closest("[data-undo]")
    if (undo) return doUndoLastTx(undo.dataset.undo)
    const del = e.target.closest("[data-delete]")
    if (del) return doSoftDelete(del.dataset.delete, del.dataset.name)
  })

  /* recycle bin */
  $("binList").addEventListener("click", (e) => {
    const r = e.target.closest("[data-restore]"); if (r) return doRestore(r.dataset.restore)
    const p = e.target.closest("[data-purge]"); if (p) return doPurge(p.dataset.purge, p.dataset.name)
  })

  /* admin sessions actions */
  $("adminSessList").addEventListener("click", (e) => {
    const save = e.target.closest("[data-save-sess]")
    if (save) return saveSessionData(save.dataset.saveSess)
  })
  $("adminSessList").addEventListener("change", (e) => {
    const up = e.target.closest("input[type=file][data-upload]")
    if (up && up.files[0]) uploadSessionVideo(up.dataset.upload, up.files[0])
  })

  /* admin quizzes actions */
  $("adminQuizList").addEventListener("click", (e) => {
    const save = e.target.closest("[data-save-quiz]")
    if (save) return saveQuizFromEditor(save.dataset.saveQuiz)
  })

  /* quiz next */
  $("quizNextBtn").addEventListener("click", nextQuizStep)

  /* recharge inputs */
  $("transferAmount").addEventListener("input", updateWaLink)
  $("senderInfo").addEventListener("input", updateWaLink)
  $("waLink").addEventListener("click", validateRecharge)

  /* copy buttons */
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]"); if (!c) return
    copyNum(c.dataset.copy)
  })

  /* enter on inputs */
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") verifyCode() })
  $("adminPassInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doAdminLogin() })

  /* resize */
  window.addEventListener("resize", () => {
    const active = document.querySelector("#authTabs .tab.active")
    if (active) moveTabIndicator(active)
  })
}

/* =====================================================
   BOOT
===================================================== */
async function boot() {
  bindEvents()

  // place tab indicator
  const active = document.querySelector("#authTabs .tab.active")
  if (active) requestAnimationFrame(() => moveTabIndicator(active))

  // load config (and subscribe for live changes)
  state.config = await getConfig().catch(() => state.config)
  if (state.unsubs.config) state.unsubs.config()
  state.unsubs.config = subscribeConfig((cfg) => { state.config = cfg })

  // prefetch sessions
  state.sessionsCache = await getAllSessions().catch(() => ({}))

  // auth watcher (one-shot splash hide on first callback)
  let firstAuthDone = false
  watchAuth((user) => {
    if (user) {
      state.user = user; state.uid = user.uid
      // realtime user listener
      if (state.unsubs.user) state.unsubs.user()
      state.unsubs.user = subscribeUser(state.uid, (fresh) => {
        if (!fresh) return
        const balChanged = state.user?.balance !== fresh.balance
        const unlockedChanged = JSON.stringify(state.user?.unlocked || {}) !== JSON.stringify(fresh.unlocked || {})
        state.user = fresh
        if (!$("profileSection").hidden) {
          if (balChanged) refreshBalUI()
          if (unlockedChanged && document.getElementById("s-details").classList.contains("active")) {
            renderLessonStats(); renderLessons()
          }
        }
      })
      afterLogin()
    } else {
      cleanupUserSubs(); state.user = null; state.uid = null
      $("profileSection").hidden = true
      if (!firstAuthDone) {
        // not logged in on first load — show login
        goTo("s-login", false)
      } else {
        // logout flow handled in doLogout
      }
    }
    if (!firstAuthDone) { firstAuthDone = true; hideSplash() }
  })

  // safety: hide splash after 4s no matter what
  setTimeout(hideSplash, 4000)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
