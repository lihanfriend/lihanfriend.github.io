// Collatz Racing - Complete Implementation
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getDatabase, ref, set, get, update, remove, onValue, onDisconnect } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-database.js";

// ==================== FIREBASE SETUP ====================
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

// ==================== GLICKO-2 RATING SYSTEM ====================
const TAU = 0.5;
const EPSILON = 0.000001;
const GLICKO2_SCALE = 173.7178;

class Glicko2 {
    constructor(rating = 1500, rd = 350, vol = 0.06) {
        this.rating = rating;
        this.rd = rd;
        this.vol = vol;
    }

    toGlicko2(r) { return (r - 1500) / GLICKO2_SCALE; }
    fromGlicko2(mu) { return mu * GLICKO2_SCALE + 1500; }
    rdToGlicko2(rd) { return rd / GLICKO2_SCALE; }
    rdFromGlicko2(phi) { return phi * GLICKO2_SCALE; }

    g(phi) { return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI)); }
    E(mu, muJ, phiJ) { return 1 / (1 + Math.exp(-this.g(phiJ) * (mu - muJ))); }

    update(opponentRating, opponentRD, score) {
        return this.updateMany([{ rating: opponentRating, rd: opponentRD, score }]);
    }

    updateMany(matches) {
        if (!matches || matches.length === 0) return this;

        const mu = this.toGlicko2(this.rating);
        const phi = this.rdToGlicko2(this.rd);

        let invV = 0;
        for (const m of matches) {
            const muJ = this.toGlicko2(m.rating);
            const phiJ = this.rdToGlicko2(m.rd);
            const g = this.g(phiJ);
            const E = 1 / (1 + Math.exp(-g * (mu - muJ)));
            invV += g * g * E * (1 - E);
        }
        const v = 1 / invV;

        let deltaSum = 0;
        for (const m of matches) {
            const muJ = this.toGlicko2(m.rating);
            const phiJ = this.rdToGlicko2(m.rd);
            const g = this.g(phiJ);
            const E = 1 / (1 + Math.exp(-g * (mu - muJ)));
            deltaSum += g * (m.score - E);
        }
        const delta = v * deltaSum;

        const sigmaPrime = this.computeNewVolatility(phi, v, delta);
        const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
        const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);

        let muPrime = mu;
        for (const m of matches) {
            const muJ = this.toGlicko2(m.rating);
            const phiJ = this.rdToGlicko2(m.rd);
            const g = this.g(phiJ);
            const E = this.E(mu, muJ, phiJ);
            muPrime += (phiPrime * phiPrime) * g * (m.score - E);
        }

        this.rating = this.fromGlicko2(muPrime);
        this.rd = Math.min(this.rdFromGlicko2(phiPrime), 350);
        this.vol = Math.max(sigmaPrime, 0.0001);

        return this;
    }

    computeNewVolatility(phi, v, delta) {
        const a = Math.log(this.vol * this.vol);
        const deltaSq = delta * delta;
        const phiSq = phi * phi;
    
        const f = (x) => {
            const ex = Math.exp(x);
            const top = ex * (deltaSq - phiSq - v - ex);
            const bottom = 2 * Math.pow(phiSq + v + ex, 2);
            return (top / bottom) - ((x - a) / (TAU * TAU));
        };
    
        let A = a;
        let B;
    
        if (deltaSq > phiSq + v) {
            B = Math.log(deltaSq - phiSq - v);
        } else {
            B = a - TAU;
        }
    
        let fA = f(A);
        let fB = f(B);
    
        let iterations = 0;
        const MAX_ITERATIONS = 1000; // Safety limit
    
        while (fB > 0 && iterations < MAX_ITERATIONS) {
            B -= TAU;
            fB = f(B);
            iterations++;
        }
    
        if (iterations >= MAX_ITERATIONS) {
            console.error('Max iterations reached in first while loop');
            return this.vol; // Return current volatility if stuck
        }
    
        iterations = 0;
        while (Math.abs(B - A) > EPSILON && iterations < MAX_ITERATIONS) {
            const C = A + (A - B) * fA / (fB - fA);
            const fC = f(C);
    
            if (fC * fB < 0) {
                A = B;
                fA = fB;
            } else {
                fA = fA / 2;
            }
    
            B = C;
            fB = fC;
            iterations++;
        }
    
        if (iterations >= MAX_ITERATIONS) {
            console.error('Max iterations reached in second while loop');
            return this.vol; // Return current volatility if stuck
        }
    
        return Math.exp(A / 2);
    }
}

// ==================== STATE ====================
let currentUser = null;
let duelID = null;
let duelRef = null;
let duelUnsubscribe = null;
let startNumber = null;
let currentNumber = null;
let stepCount = 0;
let sequence = [];
let gameStarted = false;
let ratingUpdated = false;
let gameFinishedNormally = false;
let preGameRating = null;
let startTime = 0;
let timerInterval = null;
let createCooldown = false;
let cooldownInterval = null;
let isRatedGame = true;
let isPublicGame = true;
let processingGameEnd = false;
let lobbyListUnsubscribe = null;

// ==================== DOM ====================
const $ = id => document.getElementById(id);

// ==================== OPPONENT NUMBER REVEAL ====================
let revealTimeout = null;
let isRevealing = false;

function setupOpponentReveal() {
    const container = $('opponentNumberContainer');
    const numberElement = $('opponentNumber');
    const hintElement = $('revealHint');
    let actualNumber = '?';
    let cooldownTimeout = null;
    let isOnCooldown = false;
    
    const revealNumber = () => {
        if (isRevealing || isOnCooldown) return; // Prevent clicks during reveal or cooldown
        
        isRevealing = true;
        numberElement.textContent = actualNumber;
        hintElement.textContent = '👁️ Revealed (3s)';
        hintElement.className = 'text-xs text-green-400 mt-1';
        
        revealTimeout = setTimeout(() => {
            numberElement.textContent = '?';
            isRevealing = false;
            
            // Start cooldown
            isOnCooldown = true;
            let cooldownLeft = 5;
            hintElement.textContent = `⏳ Cooldown (${cooldownLeft}s)`;
            hintElement.className = 'text-xs text-yellow-400 mt-1';
            
            const cooldownInterval = setInterval(() => {
                cooldownLeft--;
                if (cooldownLeft > 0) {
                    hintElement.textContent = `⏳ Cooldown (${cooldownLeft}s)`;
                } else {
                    clearInterval(cooldownInterval);
                    isOnCooldown = false;
                    hintElement.textContent = '👁️ Click to peek';
                    hintElement.className = 'text-xs text-gray-500 mt-1';
                }
            }, 1000);
        }, 3000);
    };
    
    // Single click to reveal
    container.onclick = revealNumber;
    container.ontouchend = (e) => {
        e.preventDefault();
        revealNumber();
    };
    
    // Store the actual number update function
    window.updateOpponentNumber = (num) => {
        actualNumber = num;
        if (!isRevealing) {
            numberElement.textContent = '?';
        }
    };
}

// ==================== COLLATZ ====================
function collatzStep(n) { return n % 2 === 0 ? n / 2 : 3 * n + 1; }

function getTotalSteps(n) {
    let temp = n, count = 0;
    while (temp !== 1) { temp = collatzStep(temp); count++; }
    return count;
}

function generateStartingNumber() {
    while (true) {
        const n = Math.floor(Math.random() * 100) + 10;
        const steps = getTotalSteps(n);
        if (steps >= 5 && steps <= 20) return n;
    }
}

async function generateShortCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempts = 0; attempts < 10; attempts++) {
        let code = Array(6).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
        const exists = await get(ref(db, `duels/${code}`));
        if (!exists.exists()) return code;
    }
    return Array(7).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ==================== AUTH ====================
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        $('loginScreen').classList.add('hidden');
        $('lobbyScreen').classList.remove('hidden');
        await initializeUserRating(user.uid);
        await displayUserRating(user.uid);
        $('userInfoDisplay').textContent = `Signed in as: ${user.displayName || 'Anonymous'}`;
        
        // Hide leaderboard and lobby list by default on login
        $('leaderboardContainer').classList.add('hidden');
        $('toggleLeaderboardBtn').textContent = '🏆 Show Leaderboard';
        $('lobbyListContainer').classList.add('hidden');
        $('toggleLobbyListBtn').textContent = '🎮 Show Active Duels';
    } else {
        $('loginScreen').classList.remove('hidden');
        $('lobbyScreen').classList.add('hidden');
        $('gameScreen').classList.add('hidden');
        $('resultScreen').classList.add('hidden');
        
        // Clean up lobby list listener
        if (lobbyListUnsubscribe) {
            lobbyListUnsubscribe();
            lobbyListUnsubscribe = null;
        }
    }
});

$('loginBtn').onclick = async () => {
    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        console.error("Sign-in error:", err);
        alert(`Sign-in failed: ${err.message}`);
    }
};

$('logoutBtn').onclick = async () => {
    try {
        // Clean up listener
        if (duelUnsubscribe) {
            duelUnsubscribe();
            duelUnsubscribe = null;
        }
        
        // Clean up lobby list listener
        if (lobbyListUnsubscribe) {
            lobbyListUnsubscribe();
            lobbyListUnsubscribe = null;
        }
        
        await signOut(auth);
        duelID = null;
        duelRef = null;
        gameStarted = false;
        ratingUpdated = false;
        gameFinishedNormally = false;
        clearCreateCooldown();
        $('lobbyStatus').textContent = '';
        
        // Hide leaderboard and lobby list on logout
        $('leaderboardContainer').classList.add('hidden');
        $('toggleLeaderboardBtn').textContent = '🏆 Show Leaderboard';
        $('lobbyListContainer').classList.add('hidden');
        $('toggleLobbyListBtn').textContent = '🎮 Show Active Duels';
    } catch (err) {
        console.error("Sign-out error:", err);
    }
};

// ==================== LEADERBOARD TOGGLE ====================
$('toggleLeaderboardBtn').onclick = async () => {
    const container = $('leaderboardContainer');
    const btn = $('toggleLeaderboardBtn');
    
    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.textContent = '🏆 Hide Leaderboard';
        await loadLeaderboard();
    } else {
        container.classList.add('hidden');
        btn.textContent = '🏆 Show Leaderboard';
    }
};

// ==================== LOBBY LIST TOGGLE ====================
$('toggleLobbyListBtn').onclick = async () => {
    const container = $('lobbyListContainer');
    const btn = $('toggleLobbyListBtn');
    
    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.textContent = '🎮 Hide Active Duels';
        startLobbyListListener();
    } else {
        container.classList.add('hidden');
        btn.textContent = '🎮 Show Active Duels';
        if (lobbyListUnsubscribe) {
            lobbyListUnsubscribe();
            lobbyListUnsubscribe = null;
        }
    }
};

// ==================== USER RATING ====================
async function initializeUserRating(uid) {
    const userRef = ref(db, `users/${uid}`);
    const snap = await get(userRef);
    if (!snap.exists()) {
        await set(userRef, {
            rating: 1500, 
            rd: 350, 
            vol: 0.06, 
            games: 0,
            email: currentUser.email || 'no-email@example.com',
            displayName: currentUser.displayName || 'Anonymous'
        });
    } else {
        await update(userRef, {
            email: currentUser.email || 'no-email@example.com',
            displayName: currentUser.displayName || 'Anonymous'
        });
    }
}

async function displayUserRating(uid) {
    try {
        const snap = await get(ref(db, `users/${uid}`));
        if (snap.exists()) {
            const data = snap.val();
            const provisional = data.rd > 110 ? '?' : '';
            const gamesText = data.games === 1 ? 'game' : 'games';
            $('ratingDisplay').innerHTML = `<p class="text-lg font-bold text-blue-400">Rating: ${Math.round(data.rating)}${provisional} (${data.games} ${gamesText})</p>`;
            
            if (typeof data.rd === 'number') {
                let rdColor = 'text-green-400';
                let rdStatus = 'Stable';
                if (data.rd > 110) {
                    rdColor = 'text-yellow-400';
                    rdStatus = 'Provisional';
                } else if (data.rd > 85) {
                    rdColor = 'text-orange-400';
                    rdStatus = 'Establishing';
                }
                $('rdDisplay').innerHTML = `<p class="${rdColor}">RD: ${Math.round(data.rd)} (${rdStatus})</p>`;
            } else {
                $('rdDisplay').innerHTML = `<p class="text-gray-400">RD: Not available</p>`;
            }
        } else {
            $('ratingDisplay').innerHTML = `<p class="text-gray-400">No rating data</p>`;
            $('rdDisplay').innerHTML = '';
        }
    } catch (error) {
        console.error('Error displaying user rating:', error);
        $('ratingDisplay').innerHTML = `<p class="text-red-400">Error loading rating</p>`;
        $('rdDisplay').innerHTML = '';
    }
}

async function updateBothPlayersRating(duelData) {
    console.log('updateBothPlayersRating called');
    
    if (!isRatedGame) {
        console.log('Skipping rating update - not a rated game');
        return;
    }
    
    const p1 = duelData.player1, p2 = duelData.player2;
    if (!p1 || !p2) {
        console.log('Skipping rating update - missing player data');
        return;
    }
    
    console.log('Updating ratings for both players...');
    console.log('Player 1:', p1.displayName, 'disconnected:', p1.disconnected, 'forfeit:', p1.forfeit);
    console.log('Player 2:', p2.displayName, 'disconnected:', p2.disconnected, 'forfeit:', p2.forfeit);
    
    try {
        // Get both players' current ratings
        const p1Snap = await get(ref(db, `users/${p1.uid}`));
        const p2Snap = await get(ref(db, `users/${p2.uid}`));
        
        if (!p1Snap.exists() || !p2Snap.exists()) {
            console.error('One or both users not found in database');
            return;
        }
        
        const p1Rating = p1Snap.val();
        const p2Rating = p2Snap.val();
        
        console.log('Current ratings - P1:', p1Rating.rating, 'P2:', p2Rating.rating);
        
        // Determine winner
        const winner = determineWinner(duelData);
        console.log('Winner:', winner);
        
        // Calculate scores (1 = win, 0 = loss, 0.5 = draw)
        let p1Score = 0.5, p2Score = 0.5;
        if (winner === p1.displayName) {
            p1Score = 1;
            p2Score = 0;
        } else if (winner === p2.displayName) {
            p1Score = 0;
            p2Score = 1;
        }
        
        console.log('Scores - P1:', p1Score, 'P2:', p2Score);
        
        // Update player 1's rating
        const p1Glicko = new Glicko2(p1Rating.rating, p1Rating.rd, p1Rating.vol);
        p1Glicko.update(p2Rating.rating, p2Rating.rd, p1Score);
        
        console.log('P1 new rating:', p1Glicko.rating, 'games:', p1Rating.games + 1);
        
        await set(ref(db, `users/${p1.uid}`), {
            rating: p1Glicko.rating,
            rd: p1Glicko.rd,
            vol: p1Glicko.vol,
            games: p1Rating.games + 1,
            email: p1.email || 'no-email@example.com',
            displayName: p1.displayName
        });
        
        // Update player 2's rating
        const p2Glicko = new Glicko2(p2Rating.rating, p2Rating.rd, p2Rating.vol);
        p2Glicko.update(p1Rating.rating, p1Rating.rd, p2Score);
        
        console.log('P2 new rating:', p2Glicko.rating, 'games:', p2Rating.games + 1);
        
        await set(ref(db, `users/${p2.uid}`), {
            rating: p2Glicko.rating,
            rd: p2Glicko.rd,
            vol: p2Glicko.vol,
            games: p2Rating.games + 1,
            email: p2.email || 'no-email@example.com',
            displayName: p2.displayName
        });
        
        console.log('Both ratings updated successfully!');
        
        // Update display for current user
        if (currentUser) {
            await displayUserRating(currentUser.uid);
        }
    } catch (error) {
        console.error('Error updating ratings:', error);
    }
}

// ==================== LEADERBOARD ====================
async function loadLeaderboard() {
    try {
        const usersRef = ref(db, 'users');
        const snap = await get(usersRef);
        
        if (!snap.exists()) {
            $('leaderboard').innerHTML = '<p class="text-gray-400 text-sm text-center">No players yet</p>';
            return;
        }
        
        const users = [];
        snap.forEach(child => {
            const data = child.val();
            if (data && typeof data.rating === 'number' && 
                typeof data.games === 'number' && typeof data.rd === 'number') {
                if (data.games >= 3 && data.rd < 85) {
                    users.push({
                        uid: child.key,
                        displayName: data.displayName || 'Anonymous',
                        rating: data.rating,
                        games: data.games,
                        rd: data.rd
                    });
                }
            }
        });
        
        users.sort((a, b) => b.rating - a.rating);
        const top10 = users.slice(0, 10);
        
        if (top10.length === 0) {
            $('leaderboard').innerHTML = '<p class="text-gray-400 text-sm text-center">No ranked players yet (3+ games, RD < 85 required)</p>';
            return;
        }
        
        $('leaderboard').innerHTML = top10.map((user, index) => {
            const isCurrentUser = currentUser && user.uid === currentUser.uid;
            const bgColor = isCurrentUser ? 'bg-blue-500/20 border border-blue-500/50' : 'bg-white/5';
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            
            return `
                <div class="${bgColor} rounded-lg p-3 flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <span class="text-xl font-bold w-8">${medal}</span>
                        <span class="font-semibold ${isCurrentUser ? 'text-blue-300' : 'text-white'}">${user.displayName}</span>
                    </div>
                    <div class="text-right">
                        <span class="font-bold text-yellow-400">${Math.round(user.rating)}</span>
                        <span class="text-gray-400 text-xs ml-2">(${user.games})</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading leaderboard:', error);
        $('leaderboard').innerHTML = '<p class="text-red-400 text-sm text-center">Error loading leaderboard</p>';
    }
}
// ==================== LOBBY LIST ====================
function startLobbyListListener() {
    // Clean up existing listener
    if (lobbyListUnsubscribe) {
        lobbyListUnsubscribe();
        lobbyListUnsubscribe = null;
    }
    
    const duelsRef = ref(db, 'duels');
    lobbyListUnsubscribe = onValue(duelsRef, (snapshot) => {
        const duels = [];
        
        if (snapshot.exists()) {
            const userDuels = new Map(); // Track duels by user UID
            
            snapshot.forEach(child => {
                const data = child.val();
                const code = child.key;
                
                const isPublic = data.public !== undefined ? data.public : true;
                
                if (data && (data.status === 'pending' || data.status === 'active') && isPublic) {
                    const p1uid = data.player1 ? data.player1.uid : null;
                    
                    // Track the most recent duel for each user
                    if (p1uid && data.status === 'pending') {
                        if (!userDuels.has(p1uid)) {
                            userDuels.set(p1uid, []);
                        }
                        userDuels.get(p1uid).push(code);
                    }
                    
                    duels.push({
                        code: code,
                        status: data.status,
                        rated: data.rated !== undefined ? data.rated : true,
                        public: isPublic,
                        player1: data.player1 ? data.player1.displayName : 'Unknown',
                        player1uid: p1uid,
                        player2: data.player2 ? data.player2.displayName : null,
                        startNumber: data.startNumber
                    });
                }
            });
            
            // Delete old duplicate duels from same user (keep only the last one)
            userDuels.forEach((codes, uid) => {
                if (codes.length > 1) {
                    // Keep the last code, delete all others
                    for (let i = 0; i < codes.length - 1; i++) {
                        remove(ref(db, `duels/${codes[i]}`)).catch(err => console.error('Error removing duplicate:', err));
                    }
                }
            });
        }
        
        displayLobbyList(duels);
    }, (error) => {
        console.error('Error listening to duels:', error);
        $('lobbyList').innerHTML = '<p class="text-red-400 text-sm text-center">Error loading active duels</p>';
    });
}

function displayLobbyList(duels) {
    const lobbyList = $('lobbyList');
    
    if (duels.length === 0) {
        lobbyList.innerHTML = '<p class="text-gray-400 text-sm text-center">No active duels right now. Create one by pressing "Create Duel" below!</p>';
        return;
    }
    
    // Sort: pending first, then active
    duels.sort((a, b) => {
        if (a.status === 'pending' && b.status === 'active') return -1;
        if (a.status === 'active' && b.status === 'pending') return 1;
        return 0;
    });
    
    lobbyList.innerHTML = duels.map(duel => {
        const statusColor = duel.status === 'pending' ? 'text-yellow-400' : 'text-green-400';
        const statusText = duel.status === 'pending' ? '⏳ Waiting for opponent' : '⚔️ In Progress';
        const gameMode = duel.rated ? '⭐' : '🎮';
        const gameModeText = duel.rated ? 'Rated' : 'Casual';
        const players = duel.player2 
            ? `${duel.player1} vs ${duel.player2}`
            : `${duel.player1} (waiting for opponent)`;
        
        // Check if this is the current user's duel
        const isMyDuel = currentUser && (
            (duel.status === 'pending' && duel.code === duelID) || 
            (duel.status === 'active' && duel.code === duelID)
        );
        
        const bgColor = isMyDuel ? 'bg-blue-500/20 border border-blue-500/50' : 'bg-white/5';
        
        // Only show starting number if the game is active (both players joined)
        const showStartNumber = duel.status === 'active' && duel.player2;
        
        // Can join if: pending, not my duel, and not already in a game
        const canJoin = duel.status === 'pending' && !isMyDuel && !gameStarted && currentUser;
        const cursorClass = canJoin ? 'cursor-pointer hover:bg-white/10' : '';
        
        return `
            <div class="${bgColor} ${cursorClass} rounded-lg p-3 transition-all" 
                 data-duel-code="${duel.code}" 
                 data-can-join="${canJoin}"
                 ${canJoin ? `onclick="handleDuelClick('${duel.code}')"` : ''}>
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                        <span class="font-mono font-bold text-white">${duel.code}</span>
                        <span class="${statusColor} text-xs">${statusText}</span>
                        ${canJoin ? '<span class="text-xs text-blue-400">← Click to join</span>' : ''}
                        ${isMyDuel ? '<span class="text-xs text-cyan-400">← Your duel</span>' : ''}
                    </div>
                    <div class="flex items-center gap-1">
                        <span class="text-xs text-gray-400" title="${gameModeText}">${gameMode}</span>
                    </div>
                </div>
                <div class="text-sm text-gray-300">${players}</div>
                ${showStartNumber ? `<div class="text-xs text-gray-400 mt-1">Starting number: ${duel.startNumber}</div>` : ''}
            </div>
        `;
    }).join('');
}

// Add this new function right after displayLobbyList
window.handleDuelClick = function(code) {
    if (!currentUser) return;
    
    const input = document.getElementById('duelCodeInput');
    const joinBtn = document.getElementById('joinDuelBtn');
    
    input.value = code;
    
    const confirmed = confirm('Join duel ' + code + '?');
    if (confirmed) {
        joinBtn.click();
    }
};
// ==================== DUEL MANAGEMENT ====================
$('duelCodeInput').oninput = (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
};

$('ratedToggle').onchange = (e) => {
    isRatedGame = e.target.checked;
};

$('publicToggle').onchange = (e) => {
    isPublicGame = e.target.checked;
};

$('createDuelBtn').onclick = async () => {
    if (!currentUser) return alert("Please sign in first.");
    if (createCooldown) return alert("Please wait before creating another duel.");
    
    // Prevent spam clicking
    if (gameStarted || duelID) return alert("You already have an active duel!");
    
    // Start cooldown immediately to prevent double-clicks
    startCreateCooldown();
    
    // Delete any existing pending duels created by this user
    try {
        const duelsRef = ref(db, 'duels');
        const snapshot = await get(duelsRef);
        if (snapshot.exists()) {
            const deletionPromises = [];
            snapshot.forEach(child => {
                const data = child.val();
                const code = child.key;
                // Delete if it's pending and created by current user
                if (data && data.status === 'pending' && 
                    data.player1 && data.player1.uid === currentUser.uid) {
                    deletionPromises.push(remove(ref(db, `duels/${code}`)));
                }
            });
            await Promise.all(deletionPromises);
        }
    } catch (error) {
        console.error('Error cleaning up old duels:', error);
    }
    
    startNumber = generateStartingNumber();
    duelID = await generateShortCode();
    duelRef = ref(db, `duels/${duelID}`);
    await set(duelRef, {
        startNumber, 
        status: 'pending', 
        rated: isRatedGame,
        public: isPublicGame,
        startTime: null,
        player1: { uid: currentUser.uid, displayName: currentUser.displayName || 'Anonymous',
            email: currentUser.email || 'no-email@example.com', currentNumber: startNumber, steps: 0, finished: false }
    });
    
    onDisconnect(duelRef).remove();
    
    const gameMode = isRatedGame ? 'Rated' : 'Casual';
    $('lobbyStatus').textContent = `${gameMode} duel created! Code: ${duelID}. Waiting for opponent...`;
    
    // Automatically show the Active Duels list
    const container = $('lobbyListContainer');
    const btn = $('toggleLobbyListBtn');
    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.textContent = '🎮 Hide Active Duels';
        startLobbyListListener();
    }
    listenToDuel();
};

$('joinDuelBtn').onclick = async () => {
    if (!currentUser) return alert("Please sign in first.");
    const inputCode = $('duelCodeInput').value.trim().toUpperCase();
    if (!inputCode) return alert("Enter a duel code.");
    
    // Delete any existing pending duels created by this user before joining
    try {
        const duelsRef = ref(db, 'duels');
        const snapshot = await get(duelsRef);
        if (snapshot.exists()) {
            const deletionPromises = [];
            snapshot.forEach(child => {
                const data = child.val();
                const code = child.key;
                // Delete if it's pending and created by current user
                if (data && data.status === 'pending' && 
                    data.player1 && data.player1.uid === currentUser.uid) {
                    deletionPromises.push(remove(ref(db, `duels/${code}`)));
                }
            });
            await Promise.all(deletionPromises);
        }
    } catch (error) {
        console.error('Error cleaning up old duels before joining:', error);
    }
    
    duelID = inputCode;
    duelRef = ref(db, `duels/${duelID}`);
    const snap = await get(duelRef);
    const data = snap.exists() ? snap.val() : null;
    if (!data) { alert("Duel not found!"); duelID = null; duelRef = null; return; }
    if (data.player1 && data.player1.uid === currentUser.uid) { alert("You can't race against yourself!"); duelID = null; duelRef = null; return; }
    if (!data.player2 && data.status === 'pending') {
        startNumber = data.startNumber;
        isRatedGame = data.rated !== undefined ? data.rated : true;
        await set(ref(db, `duels/${duelID}/player2`), {
            uid: currentUser.uid, displayName: currentUser.displayName || 'Anonymous',
            email: currentUser.email || 'no-email@example.com', currentNumber: startNumber, steps: 0, finished: false
        });
        await set(ref(db, `duels/${duelID}/status`), 'active');
        const gameMode = isRatedGame ? 'Rated' : 'Casual';
        $('lobbyStatus').textContent = `Joined ${gameMode.toLowerCase()} duel ${duelID}. Starting...`;
        listenToDuel();
    } else if (data.status === 'active') {
        alert("Duel already in progress!");
    } else {
        alert("Cannot join this duel.");
    }
};

function listenToDuel() {
    if (!duelRef) return;
    
    // Reset state flags for new game
    ratingUpdated = false;
    gameFinishedNormally = false;
    processingGameEnd = false;
    
    // Unsubscribe from previous listener if it exists
    if (duelUnsubscribe) {
        duelUnsubscribe();
        duelUnsubscribe = null;
    }
    
    let hasUnsubscribed = false;
    
    // Store the unsubscribe function
    duelUnsubscribe = onValue(duelRef, async (snapshot) => {
        // Prevent processing after unsubscribe
        if (hasUnsubscribed || processingGameEnd) {
            console.log('Skipping listener callback - already processed');
            return;
        }
        
        const data = snapshot.val();
        if (!data) {
            if (!gameStarted && duelID) alert('Duel was cancelled.');
            else if (gameStarted && !gameFinishedNormally) {
                $('gameScreen').classList.add('hidden');
                $('lobbyScreen').classList.remove('hidden');
                clearInterval(timerInterval);
            }
            duelID = null; duelRef = null; 
            if (!hasUnsubscribed && duelUnsubscribe) {
                hasUnsubscribed = true;
                duelUnsubscribe();
                duelUnsubscribe = null;
            }
            return;
        }
        
        if (data.rated !== undefined) isRatedGame = data.rated;
        
        if (data.status === 'active' && !gameStarted) {
            gameStarted = true; 
            gameFinishedNormally = false; 
            startNumber = data.startNumber;
            clearCreateCooldown();
            if (duelRef) onDisconnect(duelRef).cancel();
            await setupDisconnectForfeit();
            
            // Set synchronized start time if not already set
            if (!data.startTime) {
                const syncStartTime = Date.now() + 4000; // Start in 4 seconds
                await update(duelRef, { startTime: syncStartTime });
                await startGame(syncStartTime);
            } else {
                await startGame(data.startTime);
            }
        }
        
        const opponentKey = (data.player1 && data.player1.uid === currentUser?.uid) ? 'player2' : 'player1';
        if (data[opponentKey]) {
            if (window.updateOpponentNumber) {
                window.updateOpponentNumber(data[opponentKey].currentNumber);
            }
            $('opponentSteps').textContent = data[opponentKey].steps;
        }
        
        const p1 = data.player1, p2 = data.player2;
        
        // Skip if we don't have both players yet
        if (!p1 || !p2) return;
        
        // Check for disconnects or forfeits FIRST
        if (p1.disconnected || p2.disconnected || p1.forfeit || p2.forfeit) {
            if (!ratingUpdated && !processingGameEnd) {
                console.log('=== DISCONNECT DETECTED ===');
                processingGameEnd = true;
                ratingUpdated = true;
                gameFinishedNormally = true;
                
                // UNSUBSCRIBE IMMEDIATELY before async operations
                if (!hasUnsubscribed && duelUnsubscribe) {
                    console.log('Unsubscribing from listener');
                    hasUnsubscribed = true;
                    duelUnsubscribe();
                    duelUnsubscribe = null;
                }
                
                console.log('Starting rating update (disconnect)');
                // Update BOTH players' ratings on disconnect/forfeit
                if (isRatedGame) {
                    await updateBothPlayersRating(data);
                }
                console.log('Rating update complete (disconnect)');
                
                console.log('Showing result screen (disconnect)');
                await showResult(determineWinner(data), data);
                console.log('Result screen shown (disconnect)');
                
                // Delete the duel after a short delay
                setTimeout(async () => {
                    try {
                        const duelRefToDelete = ref(db, `duels/${duelID}`);
                        await remove(duelRefToDelete);
                        console.log('Duel deleted after disconnect');
                    } catch (error) {
                        console.error('Error deleting duel:', error);
                    }
                }, 2000);
                
                console.log('=== DISCONNECT PROCESSING COMPLETE ===');
            }
            return;
        }
        
        // Check if either player finished (reached 1 or got wrong answer)
        if (p1.finished || p2.finished) {
            if (!ratingUpdated && !processingGameEnd) {
                console.log('=== GAME END DETECTED ===');
                console.log('P1 finished:', p1.finished, 'P2 finished:', p2.finished);
                
                processingGameEnd = true;
                ratingUpdated = true;
                gameFinishedNormally = true;
                
                // UNSUBSCRIBE IMMEDIATELY before async operations
                if (!hasUnsubscribed && duelUnsubscribe) {
                    console.log('Unsubscribing from listener');
                    hasUnsubscribed = true;
                    duelUnsubscribe();
                    duelUnsubscribe = null;
                }
                
                console.log('Starting rating update');
                // Now do the async operations
                if (isRatedGame) {
                    await updateBothPlayersRating(data);
                }
                console.log('Rating update complete');
                
                console.log('Showing result screen');
                await showResult(determineWinner(data), data);
                console.log('Result screen shown');
                
                console.log('=== GAME END PROCESSING COMPLETE ===');
            }
        }
    });
}

async function setupDisconnectForfeit() {
    if (!duelRef || !currentUser) return;
    const snap = await get(duelRef);
    const data = snap.val();
    if (!data) return;
    
    const playerKey = (data.player1 && data.player1.uid === currentUser.uid) ? 'player1' : 'player2';
    const playerRef = ref(db, `duels/${duelID}/${playerKey}`);
    
    // Set up disconnect handler to mark player as disconnected
    onDisconnect(playerRef).update({ 
        finished: true, 
        disconnected: true, 
        forfeit: true,
        disconnectTime: Date.now()
    });
}

function startCreateCooldown() {
    createCooldown = true;
    const btn = $('createDuelBtn');
    let timeLeft = 15;
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    btn.textContent = `Wait ${timeLeft}s`;
    clearInterval(cooldownInterval);
    cooldownInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) btn.textContent = `Wait ${timeLeft}s`;
        else {
            clearInterval(cooldownInterval); createCooldown = false;
            btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed');
            btn.textContent = 'Create Duel';
        }
    }, 1000);
}

function clearCreateCooldown() {
    if (cooldownInterval) { clearInterval(cooldownInterval); cooldownInterval = null; }
    createCooldown = false;
    const btn = $('createDuelBtn');
    btn.disabled = false; btn.classList.remove('opacity-50', 'cursor-not-allowed'); btn.textContent = 'Create Duel';
}

// ==================== GAME ====================
async function startGame(syncStartTime) {
    if (currentUser && isRatedGame) {
        const snap = await get(ref(db, `users/${currentUser.uid}`));
        if (snap.exists()) preGameRating = snap.val().rating;
    } else preGameRating = null;
    
    currentNumber = startNumber; 
    stepCount = 0; 
    sequence = [currentNumber];
    
    $('lobbyScreen').classList.add('hidden'); 
    $('gameScreen').classList.remove('hidden');
    setupOpponentReveal();
    
    const badge = $('gameModeBadge');
    if (isRatedGame) {
        badge.textContent = '⭐ Rated Game';
        badge.className = 'inline-block px-4 py-2 rounded-full text-sm font-semibold bg-blue-500/30 border border-blue-500/50';
    } else {
        badge.textContent = '🎮 Casual Game';
        badge.className = 'inline-block px-4 py-2 rounded-full text-sm font-semibold bg-white/10 border border-white/20';
    }
    
    $('answerInput').disabled = true; 
    $('submitBtn').disabled = true; 
    $('feedback').textContent = '';
    $('yourSteps').textContent = '0'; 
    $('opponentNumber').textContent = '?'; 
    $('opponentSteps').textContent = '0';
    $('gameTimer').textContent = '0.0s';
    
    // Clear the sequence log immediately
    const log = $('sequenceLog');
    if (log) log.innerHTML = '';
    
    // Make sure timer is not running
    clearInterval(timerInterval);
    timerInterval = null;
    startTime = 0;
    
    // Calculate time until synchronized start
    const now = Date.now();
    const timeUntilStart = syncStartTime - now;
    
    if (timeUntilStart > 100) {
        // Show countdown based on synchronized time
        const countdownSeconds = Math.ceil(timeUntilStart / 1000);
        for (let i = Math.min(countdownSeconds, 3); i > 0; i--) {
            $('yourNumber').textContent = i; 
            $('yourNumber').className = 'text-6xl font-bold text-yellow-400 animate-pulse';
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    $('yourNumber').textContent = 'GO!'; 
    $('yourNumber').className = 'text-6xl font-bold text-green-400';
    
    // Wait until exact start time
    const waitTime = syncStartTime - Date.now();
    if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
    }
    
    $('yourNumber').className = 'text-3xl font-bold text-yellow-400';
    $('yourNumber').textContent = currentNumber; 
    $('yourSteps').textContent = stepCount;
    $('opponentNumber').textContent = '?'; 
    $('answerInput').value = '';
    $('answerInput').disabled = false; 
    $('submitBtn').disabled = false;
    
    // NOW start the timer - synchronized for both players
    startTime = syncStartTime;
    timerInterval = setInterval(() => { 
        const elapsed = (Date.now() - startTime) / 1000;
        $('gameTimer').textContent = elapsed.toFixed(1) + 's'; 
    }, 100);
    
    updateSequenceLog(); 
    setTimeout(() => $('answerInput').focus(), 100);
}

function updateSequenceLog() {
    const log = $('sequenceLog');
    if (!log) return;
    log.innerHTML = '';
    sequence.forEach((num, index) => {
        const span = document.createElement('span');
        if (num === 1) span.className = 'px-3 py-1 bg-green-500 rounded-lg text-white font-mono font-bold';
        else if (index === sequence.length - 1) span.className = 'px-3 py-1 bg-blue-500 rounded-lg text-white font-mono font-bold';
        else span.className = 'px-3 py-1 bg-white/20 rounded-lg text-white font-mono';
        span.textContent = num; log.appendChild(span);
        if (index < sequence.length - 1) {
            const arrow = document.createElement('span');
            arrow.className = 'text-gray-400'; arrow.textContent = '→'; log.appendChild(arrow);
        }
    });
}

async function submitAnswer() {
    if (!duelID) { $('feedback').textContent = 'No active duel.'; return; }
    const input = $('answerInput');
    const answer = parseInt(input.value);
    const correct = collatzStep(currentNumber);
    const feedback = $('feedback');
    if (isNaN(answer)) {
        feedback.textContent = '⚠️ Enter a number!';
        feedback.className = 'mt-4 text-center text-lg font-semibold min-h-[28px] text-yellow-400';
        return;
    }
    const snap = await get(duelRef);
    const data = snap.val();
    if (!data) return;
    const playerKey = (data.player1 && data.player1.uid === currentUser.uid) ? 'player1' : 'player2';
    if (answer !== correct) {
        clearInterval(timerInterval); $('answerInput').disabled = true; $('submitBtn').disabled = true;
        feedback.textContent = `✗ WRONG! (${currentNumber} → ${correct})`;
        feedback.className = 'mt-4 text-center text-lg font-semibold min-h-[28px] text-red-400';
        await update(ref(db, `duels/${duelID}/${playerKey}`), { finished: true });
        return;
    }
    currentNumber = answer; stepCount++; sequence.push(currentNumber);
    $('yourNumber').textContent = currentNumber; $('yourSteps').textContent = stepCount;
    updateSequenceLog();
    await update(ref(db, `duels/${duelID}/${playerKey}`), { currentNumber: currentNumber, steps: stepCount });
    feedback.textContent = '✓ Correct!';
    feedback.className = 'mt-4 text-center text-lg font-semibold min-h-[28px] text-green-400';
    input.value = ''; setTimeout(() => input.focus(), 50);
    if (currentNumber === 1) {
        clearInterval(timerInterval); $('answerInput').disabled = true; $('submitBtn').disabled = true;
        await update(ref(db, `duels/${duelID}/${playerKey}`), { finished: true });
    }
}

$('submitBtn').onclick = submitAnswer;
$('answerInput').onkeypress = (e) => { if (e.key === 'Enter') submitAnswer(); };

function determineWinner(duelData) {
    const p1 = duelData.player1, p2 = duelData.player2;
    if (!p1 || !p2) return null;
    if (p1.disconnected || p1.forfeit) return p2.displayName;
    if (p2.disconnected || p2.forfeit) return p1.displayName;
    if (p1.currentNumber === 1 && p2.currentNumber !== 1) return p1.displayName;
    if (p2.currentNumber === 1 && p1.currentNumber !== 1) return p2.displayName;
    if (p1.currentNumber === 1 && p2.currentNumber === 1) return (p1.steps <= p2.steps) ? p1.displayName : p2.displayName;
    if (p1.finished && !p2.finished) return p2.displayName;
    if (p2.finished && !p1.finished) return p1.displayName;
    if (p1.finished && p2.finished) return (p1.steps >= p2.steps) ? p1.displayName : p2.displayName;
    return null;
}

async function showResult(winner, duelData) {
    console.log('showResult called, winner:', winner);
    
    $('gameScreen').classList.add('hidden'); 
    $('resultScreen').classList.remove('hidden');
    const p1 = duelData.player1, p2 = duelData.player2;
    $('resultTitle').textContent = winner ? `Winner: ${winner}` : 'Draw!';
    $('resultEmoji').textContent = winner ? '🏆' : '🤝';
    $('finalSteps').textContent = stepCount;
    $('finalTime').textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
    let forfeitMsg = '';
    if (p1.disconnected || p1.forfeit) forfeitMsg = `${p1.displayName} disconnected and forfeited!`;
    else if (p2.disconnected || p2.forfeit) forfeitMsg = `${p2.displayName} disconnected and forfeited!`;
    $('forfeitMessage').textContent = forfeitMsg;
    
    await new Promise(r => setTimeout(r, 500));
    
    const ratingDisplay = $('ratingChangeDisplay');
    if (currentUser && isRatedGame) {
        try {
            const snap = await get(ref(db, `users/${currentUser.uid}`));
            if (snap.exists()) {
                const newRating = snap.val();
                const change = preGameRating ? (newRating.rating - preGameRating).toFixed(1) : 0;
                const changeColor = change > 0 ? 'text-green-400' : 'text-red-400';
                const changeSign = change > 0 ? '+' : '';
                ratingDisplay.innerHTML = `
                    <p class="text-blue-400 font-bold">Your New Rating: ${Math.round(newRating.rating)}</p>
                    ${preGameRating ? `<p class="${changeColor} text-sm">${changeSign}${change} rating change</p>` : ''}
                    <p class="text-gray-400 text-sm">${newRating.games} games played</p>
                `;
            }
        } catch (error) {
            console.error('Error displaying rating in showResult:', error);
        }
    } else if (!isRatedGame) {
        ratingDisplay.innerHTML = `<p class="text-gray-400 text-sm">🎮 Casual Game - No rating change</p>`;
    }
    
    console.log('showResult completed');
}

$('returnLobbyBtn').onclick = async () => {
    $('resultScreen').classList.add('hidden'); 
    $('lobbyScreen').classList.remove('hidden');
    $('duelCodeInput').value = ''; 
    $('lobbyStatus').textContent = '';
    $('answerInput').value = '';
    
    // Clear timer
    clearInterval(timerInterval);
    timerInterval = null;
    startTime = 0;
    $('gameTimer').textContent = '0.0s';
    
    // Clean up listener
    if (duelUnsubscribe) {
        duelUnsubscribe();
        duelUnsubscribe = null;
    }
    
    // Cancel disconnect handlers and delete the duel
    if (duelRef && duelID) {
        try {
            // Cancel any pending disconnect handlers
            const snap = await get(duelRef);
            if (snap.exists()) {
                const data = snap.val();
                if (data && currentUser) {
                    const playerKey = (data.player1 && data.player1.uid === currentUser.uid) ? 'player1' : 'player2';
                    const playerRef = ref(db, `duels/${duelID}/${playerKey}`);
                    onDisconnect(playerRef).cancel();
                    onDisconnect(duelRef).cancel();
                }
            }
            
            // Always try to delete the duel when returning to lobby
            await remove(duelRef);
        } catch (error) {
            console.error('Error cleaning up duel:', error);
        }
    }
    
    // Reset game state BEFORE updating UI
    duelID = null; 
    duelRef = null; 
    gameStarted = false; 
    ratingUpdated = false; 
    gameFinishedNormally = false;
    processingGameEnd = false;
    
    if (currentUser) {
        await displayUserRating(currentUser.uid);
        // Only reload leaderboard if it's currently visible
        if (!$('leaderboardContainer').classList.contains('hidden')) {
            await loadLeaderboard();
        }
        // Refresh lobby list if visible
        if (!$('lobbyListContainer').classList.contains('hidden')) {
            // The listener should still be active and will update automatically
            // But we can ensure it's running
            if (!lobbyListUnsubscribe) {
                startLobbyListListener();
            }
        }
    }
};
