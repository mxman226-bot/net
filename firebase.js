// =====================================================
// firebase.js  —  Firebase initialization (auth + db + storage)
// =====================================================

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, indexedDBLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyAYoOvMv6h2kBddMYqWQu9CpBamt1SsCQM",
  authDomain: "mido-34f40.firebaseapp.com",
  projectId: "mido-34f40",
  storageBucket: "mido-34f40.firebasestorage.app",
  messagingSenderId: "529723164634",
  appId: "1:529723164634:web:c73c2fac1074bc968d62e3",
  measurementId: "G-SVF2Q7ZKJ6"
};

// Avoid duplicate initialization
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);

// Persist auth across reloads/sessions (IndexedDB → localStorage fallback)
setPersistence(auth, indexedDBLocalPersistence)
  .catch(() => setPersistence(auth, browserLocalPersistence))
  .catch((e) => console.log("[v0] persistence error", e));

export default app;
