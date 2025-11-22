// index.js (module) - Collatz Duel with Firebase Auth + RTDB + Glicko-2
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getDatabase, ref, set, push, onValue, update, get, remove } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";

// -------------------------
// Firebase config & init
// -------------------------
const firebaseConfig = {
    apiKey: "AIzaSyB9oK73wo05B6YHViDTUsh2gT-04G4FpP8",
    authDomain: "collatz-racing.firebaseapp.com",
    databaseURL: "https://collatz-racing-default-rtdb.firebaseio.com",
    projectId: "collatz-racing",
    storageBucket: "collatz-racing.firebasestorage.app",
    messagingSenderId: "78351409018",
    appId: "1:78351409018:web:ff8ecfd3e6018f896dc0c3",
    measurementId: "G-5J0FS12HGE"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const db = getDatabase(app);

// -------------------------
// Glicko-2 Constants
// -------------------------
const TAU = 0.5; // System constant (volatility change)
const EPSILON = 0.000001; // Convergence tolerance
const GLICKO2_SCALE = 173.7178; // Glicko-2 scale factor

// -------------------------
// Glicko-2 Rating System
// -------------------------
class Glicko2 {
    constructor(rating = 1500, rd = 350, vol = 0.06) {
        this.rating = rating;
        this.rd = rd;
        this.vol = vol;
    }

    // Convert rating to Glicko-2 scale
    toGlicko2(r) {
        return (r - 1500) / GLICKO2_SCALE;
    }

    // Convert back to normal scale
    fromGlicko2(mu) {
        return mu * GLICKO2_SCALE + 1500;
    }

    // Convert RD to Glicko-2 scale
    rdToGlicko2(rd) {
        return rd / GLICKO2_SCALE;
    }

    // Convert RD back to normal scale
    rdFromGlicko2(phi) {
        return phi * GLICKO2_SCALE;
    }

    // g function
    g(phi) {
        return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
    }

    // E function (expected score)
    E(mu, muJ, phiJ) {
        return 1 / (1 + Math.exp(-this.g(phiJ) * (mu - muJ)));
    }

    // Update rating after a game
    update(opponentRating, opponentRD, score) {
        // Convert to Glicko-2 scale
        const mu = this.toGlicko2(this.rating);
        const phi = this.rdToGlicko2(this.rd);
        const muJ = this.toGlicko2(opponentRating);
        const phiJ = this.rdToGlicko2(opponentRD);

        // Step 3: Compute v (variance)
        const gPhi = this.g(phiJ);
        const e = this.E(mu, muJ, phiJ);
        const v = 1 / (gPhi * gPhi * e * (1 - e));

        // Step 4: Compute delta (improvement)
        const delta = v * gPhi * (score - e);

        // Step 5: Determine new volatility (iterative)
        const sigma = this.computeNewVolatility(phi, v, delta);

        // Step 6: Update rating deviation to new pre-rating period value
        const phiStar = Math.sqrt(phi * phi + sigma * sigma);

        // Step 7: Update rating and RD to new values
        const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
        const muPrime = mu + phiPrime * phiPrime * gPhi * (score - e);

        // Convert back to normal scale
        this.rating = this.fromGlicko2(muPrime);
        this.rd = this.rdFromGlicko2(phiPrime);
        this.vol = sigma;

        return this;
    }

    // Illinois algorithm for volatility
    computeNewVolatility(phi, v, delta) {
        const sigma = this.vol;
        const a = Math.log(sigma * sigma);
        const deltaSq = delta * delta;
        const phiSq = phi * phi;

        const f = (x) => {
            const eX = Math.exp(x);
            const phiSqPlusV = phiSq + v + eX;
            const term1 = eX * (deltaSq - phiSq - v - eX) / (2 * phiSqPlusV * phiSqPlusV);
            const term2 = (x - a) / (TAU * TAU);
            return term1 - term2;
        };

        let A = a;
        let B;
        if (deltaSq > phiSq + v) {
            B = Math.log(deltaSq - phiSq - v);
        } else {
            let k = 1;
            while (f(a - k * TAU) < 0) {
                k++;
            }
            B = a - k * TAU;
        }

        let fA = f(A);
        let fB = f(B);

        // Illinois algorithm iteration
        while (Math.abs(B - A) > EPSILON) {
            const C = A + (A - B) * fA / (fB - fA);
            const fC = f(C);

            if (fC * fB <= 0) {
                A = B;
                fA = fB;
            } else {
                fA = fA / 2;
            }

            B = C;
            fB = fC;
        }

        return Math.exp(A / 2);
    }
}

// -------------------------
// Game & duel state
// -------------------------
let currentUser = null;
let duelID = null;
let startNumber = null;
let currentNum = null, stepCount = 0;
let opponentData = { currentNumber: null, steps: 0 };
let timerInterval = null, startTime = 0;
let sequence = [];
let duelRef = null;
let gameStarted = false;
let ratingUpdated = false;
let preGameRating = null; // Store rating before game starts
let createCooldown = false; // Track if create button is on cooldown
let cooldownTimer = null; // Store cooldown interval

// -------------------------
// DOM refs
// -------------------------
const $ = id => document.getElementById(id);
const loginScreen = $('loginScreen');
const duelLobby = $('duelLobby');
const gameScreen = $('gameScreen');
const resultScreen = $('resultScreen');

// Setup input filtering for duel code
const duelInput = $('duelIDInput');
duelInput.addEventListener('input', (e) => {
    // Auto-capitalize and filter to only letters and numbers
    let value = e.target.value.toUpperCase();
    value = value.replace(/[^A-Z0-9]/g, '');
    e.target.value = value;
});

// -------------------------
// Auth listener
// -------------------------
onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
        loginScreen.classList.add('hidden');
        duelLobby.classList.remove('hidden');
        // Initialize user rating if doesn't exist
        initializeUserRating(user.uid);
        // Display user rating
        displayUserRating(user.uid);
        const userInfo2 = document.getElementById('userInfo2');
        if(userInfo2) {
            userInfo2.textContent = `Signed in as: ${user.displayName || 'Anonymous'}`;
        }
    } else {
        loginScreen.classList.remove('hidden');
        duelLobby.classList.add('hidden');
    }
});

// -------------------------
// Initialize user rating
// -------------------------
async function initializeUserRating(uid) {
    const userRef = ref(db, `users/${uid}/rating`);
    const snap = await get(userRef);
    if (!snap.exists()) {
        await set(userRef, {
            rating: 1500,
            rd: 350,
            vol: 0.06,
            games: 0
        });
    }
}

// -------------------------
// Display user rating
// -------------------------
async function displayUserRating(uid) {
    const userRef = ref(db, `users/${uid}/rating`);
    const snap = await get(userRef);
    if (snap.exists()) {
        const data = snap.val();
        const ratingDisplay = document.createElement('p');
        ratingDisplay.id = 'ratingDisplay';
        ratingDisplay.className = 'text-lg font-bold text-blue-400 mt-2';
        ratingDisplay.textContent = `Rating: ${data.rating.toFixed(2)} (${data.games} games)`;
        
        const existing = document.getElementById('ratingDisplay');
        if (existing) existing.remove();
        
        // Add to duel lobby instead of login screen
        duelLobby.appendChild(ratingDisplay);
    }
}

// -------------------------
// Login/Logout wiring
// -------------------------
$('loginBtn').addEventListener('click', async () => {
    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        console.error("Sign-in error:", err);
        alert("Sign-in failed. See console for details.");
    }
});

$('logoutBtn').addEventListener('click', async () => {
    try {
        await signOut(auth);
        duelID = null;
        duelRef = null;
        startNumber = null;
        gameStarted = false;
        ratingUpdated = false;
        clearCreateCooldown(); // Clear cooldown on logout
        $('duelStatus').textContent = '';
    } catch (err) {
        console.error("Sign-out error:", err);
        alert("Sign-out failed. See console.");
    }
});

// -------------------------
// Start Create Cooldown
// -------------------------
function startCreateCooldown() {
    createCooldown = true;
    const btn = $('createDuelBtn');
    let timeLeft = 15;
    
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    const originalText = btn.textContent;
    btn.textContent = `Wait ${timeLeft}s`;
    
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
        timeLeft--;
        if(timeLeft > 0) {
            btn.textContent = `Wait ${timeLeft}s`;
        } else {
            clearInterval(cooldownTimer);
            createCooldown = false;
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
            btn.textContent = originalText;
        }
    }, 1000);
}

// -------------------------
// Clear Create Cooldown (when duel starts)
// -------------------------
function clearCreateCooldown() {
    if(cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
    }
    createCooldown = false;
    const btn = $('createDuelBtn');
    btn.disabled = false;
    btn.classList.remove('opacity-50', 'cursor-not-allowed');
    btn.textContent = 'Create Duel';
}

// -------------------------
// Generate short code for duels
// -------------------------
async function generateShortCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars like 0, O, I, 1
    let code = '';
    let attempts = 0;
    const maxAttempts = 10;
    
    // Keep generating until we find a unique code
    while(attempts < maxAttempts) {
        code = '';
        for(let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        // Check if this code already exists
        const existingDuel = await get(ref(db, `duels/${code}`));
        if(!existingDuel.exists()) {
            return code;
        }
        attempts++;
    }
    
    // If we somehow couldn't find a unique code after 10 tries, add a random suffix
    return code + chars.charAt(Math.floor(Math.random() * chars.length));
}

// -------------------------
// Collatz helpers
// -------------------------
function collatzStep(n){ return n % 2 === 0 ? n / 2 : 3 * n + 1; }
function getTotalSteps(n){ let t = n, c = 0; while(t !== 1){ t = collatzStep(t); c++; } return c; }
function generateStartingNumber(){
    while(true){
        const n = Math.floor(Math.random() * 100) + 10;
        const s = getTotalSteps(n);
        if(s >= 5 && s <= 20) return n;
    }
}

// -------------------------
// Duel Create/Join
// -------------------------
$('createDuelBtn').addEventListener('click', async () => {
    if(!currentUser){ alert("Please sign in first."); return; }
    if(createCooldown){ 
        alert("Please wait before creating another duel."); 
        return; 
    }
    
    startNumber = generateStartingNumber();
    // Generate short 6-character code (now async)
    duelID = await generateShortCode();
    duelRef = ref(db, `duels/${duelID}`);

    const payload = {
        startNumber,
        status: 'pending',
        player1: {
            uid: currentUser.uid,
            displayName: currentUser.displayName || 'Anonymous',
            currentNumber: startNumber,
            steps: 0,
            finished: false
        }
    };

    try {
        await set(duelRef, payload);
        $('duelStatus').textContent = `Duel created! ID: ${duelID}. Waiting for opponent...`;
        gameStarted = false;
        ratingUpdated = false;
        listenDuel();
        
        // Start cooldown
        startCreateCooldown();
    } catch (err) {
        console.error("Error creating duel:", err);
        alert("Failed to create duel.");
    }
});

$('joinDuelBtn').addEventListener('click', async () => {
    if(!currentUser){ alert("Please sign in first."); return; }
    const inputID = $('duelIDInput').value.trim().toUpperCase(); // Convert to uppercase
    if(!inputID){ alert("Enter a duel ID"); return; }

    duelID = inputID;
    duelRef = ref(db, `duels/${duelID}`);

    try {
        const snap = await get(duelRef);
        const data = snap.exists() ? snap.val() : null;
        if(!data){ alert("Duel not found!"); duelID = null; duelRef = null; return; }

        // Check if trying to join own duel
        if(data.player1 && data.player1.uid === currentUser.uid) {
            alert("You can't race against yourself!");
            duelID = null;
            duelRef = null;
            return;
        }

        if(!data.player2 && data.status === 'pending'){
            startNumber = data.startNumber;
            const player2Ref = ref(db, `duels/${duelID}/player2`);
            await set(player2Ref, {
                uid: currentUser.uid,
                displayName: currentUser.displayName || 'Anonymous',
                currentNumber: startNumber,
                steps: 0,
                finished: false
            });
            const statusRef = ref(db, `duels/${duelID}/status`);
            await set(statusRef, 'active');
            $('duelStatus').textContent = `Joined duel ${duelID}. Game starting!`;
            gameStarted = false;
            ratingUpdated = false;
            listenDuel();
            startGame();
        } else if(data.status === 'active'){
            alert("Duel already in progress!");
        } else {
            alert("Cannot join this duel.");
        }
    } catch (err) {
        console.error("Error joining duel:", err);
        alert("Failed to join duel.");
    }
});

// -------------------------
// Listen for duel updates
// -------------------------
function listenDuel(){
    if(!duelRef) return;
    onValue(duelRef, snapshot => {
        const data = snapshot.val();
        if(!data) return;

        if(data.status === 'active' && !gameStarted){
            gameStarted = true;
            startNumber = data.startNumber;
            clearCreateCooldown(); // Clear cooldown when duel starts
            startGame();
        }

        let opponentKey = 'player2';
        if(data.player1 && data.player1.uid === (currentUser && currentUser.uid)) opponentKey = 'player2';
        else opponentKey = 'player1';

        if(data[opponentKey]){
            opponentData.currentNumber = data[opponentKey].currentNumber;
            opponentData.steps = data[opponentKey].steps;
            $('opponentNumber').textContent = opponentData.currentNumber;
            $('opponentStepCount').textContent = opponentData.steps;
        }

        if(data.player1 && data.player2 && (data.player1.finished || data.player2.finished)){
            if(!ratingUpdated) {
                updateRatings(data);
                ratingUpdated = true;
            }
            const winner = determineWinner(data);
            showResult(winner, data);
        }
    });
}

// -------------------------
// Update ratings using Glicko-2
// -------------------------
async function updateRatings(duelData) {
    const p1 = duelData.player1;
    const p2 = duelData.player2;
    if(!p1 || !p2) return;

    // Fetch both players' ratings
    const p1RatingSnap = await get(ref(db, `users/${p1.uid}/rating`));
    const p2RatingSnap = await get(ref(db, `users/${p2.uid}/rating`));

    const p1Data = p1RatingSnap.val() || { rating: 1500, rd: 350, vol: 0.06, games: 0 };
    const p2Data = p2RatingSnap.val() || { rating: 1500, rd: 350, vol: 0.06, games: 0 };

    // Create Glicko-2 objects
    const p1Glicko = new Glicko2(p1Data.rating, p1Data.rd, p1Data.vol);
    const p2Glicko = new Glicko2(p2Data.rating, p2Data.rd, p2Data.vol);

    // Determine outcome (1 = win, 0 = loss, 0.5 = draw)
    let p1Score = 0.5;
    let p2Score = 0.5;

    const winner = determineWinner(duelData);
    if(winner === p1.displayName) {
        p1Score = 1;
        p2Score = 0;
    } else if(winner === p2.displayName) {
        p1Score = 0;
        p2Score = 1;
    }

    // Update ratings
    p1Glicko.update(p2Data.rating, p2Data.rd, p1Score);
    p2Glicko.update(p1Data.rating, p1Data.rd, p2Score);

    // Save back to Firebase
    await set(ref(db, `users/${p1.uid}/rating`), {
        rating: p1Glicko.rating,
        rd: p1Glicko.rd,
        vol: p1Glicko.vol,
        games: p1Data.games + 1
    });

    await set(ref(db, `users/${p2.uid}/rating`), {
        rating: p2Glicko.rating,
        rd: p2Glicko.rd,
        vol: p2Glicko.vol,
        games: p2Data.games + 1
    });

    // Update display
    if(currentUser) {
        displayUserRating(currentUser.uid);
    }
}

// -------------------------
// Start Game (local)
// -------------------------
async function startGame(){
    // Store pre-game rating
    if(currentUser) {
        const userRatingSnap = await get(ref(db, `users/${currentUser.uid}/rating`));
        if(userRatingSnap.exists()) {
            preGameRating = userRatingSnap.val().rating;
        }
    }
    
    currentNum = startNumber;
    stepCount = 0;
    sequence = [currentNum];
    duelLobby.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    $('currentNumber').textContent = currentNum;
    $('stepCount').textContent = stepCount;
    $('answerInput').value = '';
    $('answerInput').disabled = false;
    $('feedback').textContent = '';
    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 100);
    setTimeout(()=> $('answerInput').focus(), 120);
}

// -------------------------
// Timer
// -------------------------
function updateTimer(){
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    $('timer').textContent = elapsed + 's';
}

// -------------------------
// Submit Answer
// -------------------------
$('submitBtn').addEventListener('click', submitAnswer);
$('answerInput').addEventListener('keypress', e => { if(e.key === 'Enter') submitAnswer(); });

async function submitAnswer(){
    if(!duelID){ $('feedback').textContent = 'No duel active.'; return; }
    const input = $('answerInput');
    const answer = parseInt(input.value);
    const correct = collatzStep(currentNum);
    const feedback = $('feedback');
    if(isNaN(answer)){ feedback.textContent = '⚠️ Enter a number!'; feedback.className='text-yellow-400'; return; }

    const playerKey = await getPlayerKey();
    if(!playerKey){ alert("Couldn't resolve player key."); return; }

    if(answer !== correct){
        clearInterval(timerInterval);
        $('answerInput').disabled = true;
        feedback.textContent = `✗ WRONG! (${currentNum} → ${correct})`;
        feedback.className='text-red-400';
        await update(ref(db, `duels/${duelID}/${playerKey}`), { finished: true });
        return;
    }

    currentNum = answer;
    stepCount++;
    sequence.push(currentNum);
    $('currentNumber').textContent = currentNum;
    $('stepCount').textContent = stepCount;

    await update(ref(db, `duels/${duelID}/${playerKey}`), {
        currentNumber: currentNum,
        steps: stepCount
    });

    feedback.textContent = '✓ Correct!'; feedback.className='text-green-400';
    input.value = ''; input.focus();

    if(currentNum === 1){
        clearInterval(timerInterval);
        await update(ref(db, `duels/${duelID}/${playerKey}`), { finished: true });
    }
}

// -------------------------
// Determine winner
// -------------------------
function determineWinner(duelData){
    const p1 = duelData.player1;
    const p2 = duelData.player2;
    if(!p1 || !p2) return null;

    if(p1.currentNumber === 1 && p2.currentNumber !== 1) return p1.displayName;
    if(p2.currentNumber === 1 && p1.currentNumber !== 1) return p2.displayName;
    
    if(p1.currentNumber === 1 && p2.currentNumber === 1){
        return (p1.steps <= p2.steps) ? p1.displayName : p2.displayName;
    }
    
    if(p1.finished && !p2.finished) return p2.displayName;
    if(p2.finished && !p1.finished) return p1.displayName;
    
    if(p1.finished && p2.finished){
        return (p1.steps >= p2.steps) ? p1.displayName : p2.displayName;
    }
    
    return null;
}

// -------------------------
// Show result
// -------------------------
async function showResult(winner, duelData){
    gameScreen.classList.add('hidden');
    resultScreen.classList.remove('hidden');
    $('resultTitle').textContent = winner ? `Winner: ${winner}` : 'Draw!';
    $('resultEmoji').textContent = winner ? '🏆' : '🤝';
    $('finalSteps').textContent = stepCount;
    $('finalTime').textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
    
    // Show rating changes
    if(currentUser) {
        const userRatingSnap = await get(ref(db, `users/${currentUser.uid}/rating`));
        if(userRatingSnap.exists()) {
            const newRating = userRatingSnap.val();
            const ratingChange = document.createElement('div');
            ratingChange.className = 'mt-4 text-lg';
            
            // Get old rating from before the game (stored value)
            const oldRating = Math.round(newRating.rating);
            
            ratingChange.innerHTML = `
                <p class="text-blue-400 font-bold">Your New Rating: ${Math.round(newRating.rating)}</p>
                <p class="text-gray-400 text-sm">${newRating.games} games played</p>
            `;
            
            // Remove existing rating display if present
            const existingRating = resultScreen.querySelector('.rating-display');
            if(existingRating) existingRating.remove();
            
            ratingChange.classList.add('rating-display');
            resultScreen.querySelector('.bg-white\\/5').appendChild(ratingChange);
        }
    }
}

// -------------------------
// Return to Lobby
// -------------------------
$('returnLobbyBtn').addEventListener('click', async () => {
    resultScreen.classList.add('hidden');
    duelLobby.classList.remove('hidden');
    gameStarted = false;
    ratingUpdated = false;
    
    // Clear the join code input
    $('duelIDInput').value = '';
    
    // Delete the duel from database
    if(duelRef) {
        try {
            await remove(duelRef);
            console.log(`Duel ${duelID} deleted from database`);
        } catch(err) {
            console.error("Error deleting duel:", err);
        }
        duelRef = null;
        duelID = null;
    }
});

// -------------------------
// Helpers
// -------------------------
async function getPlayerKey(){
    if(!duelRef) return null;
    const snap = await get(duelRef);
    const data = snap.exists() ? snap.val() : null;
    if(!data) return null;
    if(data.player1 && data.player1.uid === (currentUser && currentUser.uid)) return 'player1';
    if(data.player2 && data.player2.uid === (currentUser && currentUser.uid)) return 'player2';
    return null;
}
