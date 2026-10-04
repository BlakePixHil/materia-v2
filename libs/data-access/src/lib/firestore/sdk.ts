/**
 * The parts of the full Firestore SDK the data layer uses, as named re-exports. The data layer
 * loads this module with `import()`, so the SDK stays out of the initial bundle, and the named
 * re-exports let the bundler drop everything else in `firebase/firestore`.
 */
export {
  clearIndexedDbPersistence,
  collection,
  collectionGroup,
  connectFirestoreEmulator,
  deleteField,
  doc,
  endAt,
  getCountFromServer,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  memoryLocalCache,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  terminate,
  updateDoc,
  waitForPendingWrites,
  where,
} from 'firebase/firestore';
