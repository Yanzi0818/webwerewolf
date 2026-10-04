import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

const firebaseConfig = {
    apiKey: "AIzaSyDIo3ZwAYlP_3vB_rFS5ef0oCZGAyNhHuY",
    authDomain: "werewolf310-14bd9.firebaseapp.com",
    databaseURL: "https://werewolf310-14bd9-default-rtdb.firebaseio.com",
    projectId: "werewolf310-14bd9",
    storageBucket: "werewolf310-14bd9.firebasestorage.app",
    messagingSenderId: "882909389373",
    appId: "1:882909389373:web:3bb023fd0276be34e8c054",
    measurementId: "G-8M1X1C1PQG"
};

const hasPlaceholderValues = Object.values(firebaseConfig).some((value) =>
	typeof value === 'string' && (
		value.startsWith('YOUR_') ||
		value.includes('YOUR_FIREBASE_PROJECT_ID') ||
		value.includes('YOUR_FIREBASE_API_KEY')
	)
);

export const isFirebaseConfigured = !hasPlaceholderValues;

export const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const db = app ? getDatabase(app) : null;
