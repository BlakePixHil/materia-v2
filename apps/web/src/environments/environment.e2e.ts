// CI e2e build (`nx build web --configuration=e2e`): production optimisations, Firebase emulators
// (project demo-materia), so no real project is ever touched.
export const environment = {
  name: 'e2e',
  useEmulators: true,
  firebase: {
    projectId: 'demo-materia',
    appId: 'demo-app-id',
    apiKey: 'demo-api-key',
    authDomain: 'demo-materia.firebaseapp.com',
    storageBucket: 'demo-materia.appspot.com',
    messagingSenderId: '000000000000',
  },
} as const;
