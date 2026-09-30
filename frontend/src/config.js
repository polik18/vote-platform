// Copy your Firebase web app config from Firebase Console > Project settings > Your apps.
// The Firebase web config is safe to expose in frontend code; authorization is enforced by Firebase Auth + the Worker API.
export const CONFIG = {
  firebase: {
    apiKey: 'REPLACE_ME',
    authDomain: 'REPLACE_ME.firebaseapp.com',
    projectId: 'REPLACE_ME',
    appId: 'REPLACE_ME'
  },
  apiBase: 'https://REPLACE_ME.workers.dev/api'
};
