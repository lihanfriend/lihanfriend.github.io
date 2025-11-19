// =========================
// Collatz Speed Challenge
// =========================

// Game state
let currentNum, startingNumber, totalSteps, stepCount;
let startTime, timerInterval;
let sequence = [];
let currentUser = null;

// -------------------------
// Firebase Auth Listener
// -------------------------
firebaseOnAuthStateChanged(firebaseAuth, (user) => {
    currentUser = user;
    if (user) {
        // User signed in → show Start Screen
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('startScreen').classList.remove('hidden');
        document.getElementById('userInfo').textContent = `Signed in as: ${user.displayName || 'Anonymous'}`;
        document.getElementById('userInfo').classList.remove('hidden');
    } else {
        // Not signed in → show Login Screen
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('startScreen').classList.add('hidden');
        document.getElementById('userInfo').classList.add('hidden');
    }
});

// -------------------------
// Login / Logout Handlers
// -------------------------
document.getElementById('loginBtn').addEventListener('click', async () => {
    try {
        await firebaseSignInWithPopup(firebaseAuth, firebaseProvider);
    } catch (err) {
        console.error("Login failed:", err);
        alert("Login failed. Check console.");
    }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        await firebaseSignOut(firebaseAuth);
    } catch (err) {
        console.error("Logout failed:", err);
        alert("Logout failed. Check console.");
    }
});

// -------------------------
// Collatz Functions
// -------------------------
function collatzStep(n) {
    return n % 2 === 0 ? n / 2 : 3 * n + 1;
}

function getTotalSteps(n) {
    let temp = n, count = 0;
    while (temp !== 1) {
        temp = collatzStep(temp);
        count++;
    }
    return count;
}

function generateStartingNumber() {
    while (true) {
        const num = Math.floor(Math.random() * 100) + 10;
        const steps = getTotalSteps(num);
        if (steps >= 5 && steps <= 20) return num;
    }
}

// -------------------------
// Start Game
// -------------------------
function startGame() {
    startingNumber = generateStartingNumber();
    currentNum = startingNumber;
    totalSteps = getTotalSteps(startingNumber);
    stepCount = 0;
    sequence = [startingNumber];

    // Update UI
    document.getElementById('startScreen').classList.add('hidden');
    document.getElementById('resultScreen').classList.add('hidden');
    document.getElementById('gameScreen').classList.remove('hidden');

    document.getElementById('startingNum').textContent = startingNumber;
    document.getElementById('currentNumber').textContent = currentNum;
    document.getElementById('stepCount').textContent = stepCount;
    document.getElementById('answerInput').value = '';
    document.getElementById('answerInput').disabled = false;
    document.getElementById('feedback').textContent = '';
    document.getElementById('progressBar').style.width = '0%';

    updateSequenceHistory();

    // Start timer
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 100);

    // Focus input
    setTimeout(() => document.getElementById('answerInput').focus(), 100);
}

// -------------------------
// Timer & Sequence History
// -------------------------
function updateTimer() {
    const elapsed = (Date.now() - startTime) / 1000;
    document.getElementById('timer').textContent = elapsed.toFixed(1) + 's';
}

function updateSequenceHistory() {
    const historyDiv = document.getElementById('sequenceHistory');
    historyDiv.innerHTML = sequence.map((num, idx) =>
        `<span class="px-3 py-1 bg-white/20 rounded-lg text-sm ${idx === sequence.length - 1 ? 'ring-2 ring-blue-500' : ''}">${num}</span>`
    ).join('');
}

// -------------------------
// Submit Answer
// -------------------------
function submitAnswer() {
    const input = document.getElementById('answerInput');
    const answer = parseInt(input.value);
    const correct = collatzStep(currentNum);
    const feedback = document.getElementById('feedback');

    if (isNaN(answer)) {
        feedback.textContent = '⚠️ Enter a number!';
        feedback.className = 'mt-4 text-center text-lg font-semibold h-8 text-yellow-400';
        return;
    }

    if (answer !== correct) {
        // Wrong
        clearInterval(timerInterval);
        document.getElementById('answerInput').disabled = true;

        feedback.textContent = `✗ WRONG! (${currentNum} → ${correct})`;
        feedback.className = 'mt-4 text-center text-lg font-semibold h-8 text-red-400';

        const gameScreen = document.getElementById('gameScreen');
        gameScreen.classList.add('shake');

        setTimeout(() => showResult(false, answer, correct), 1000);
        return;
    }

    // Correct
    currentNum = answer;
    stepCount++;
    sequence.push(currentNum);

    document.getElementById('currentNumber').textContent = currentNum;
    document.getElementById('stepCount').textContent = stepCount;
    document.getElementById('progressBar').style.width = (stepCount / totalSteps * 100) + '%';

    feedback.textContent = '✓ Correct!';
    feedback.className = 'mt-4 text-center text-lg font-semibold h-8 text-green-400';

    updateSequenceHistory();
    input.value = '';

    if (currentNum === 1) {
        clearInterval(timerInterval);
        setTimeout(() => showResult(true), 500);
        return;
    }

    input.focus();
}

// -------------------------
// Show Result
// -------------------------
function showResult(success, wrongAnswer, correctAnswer) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Save result to RTDB
    saveScoreRTDB(success, parseFloat(elapsed), stepCount, startingNumber);

    document.getElementById('gameScreen').classList.add('hidden');
    document.getElementById('resultScreen').classList.remove('hidden');

    document.getElementById('finalSteps').textContent = stepCount;
    document.getElementById('finalTime').textContent = elapsed + 's';

    if (success) {
        document.getElementById('resultEmoji').textContent = '🎉';
        document.getElementById('resultTitle').textContent = 'Perfect!';
        document.getElementById('failureReason').innerHTML =
            `<p class="text-green-400 font-semibold">You completed the sequence without mistakes!</p>`;
    } else {
        document.getElementById('resultEmoji').textContent = '💥';
        document.getElementById('resultTitle').textContent = 'Game Over!';
        document.getElementById('failureReason').innerHTML =
            `<div class="mt-4 p-4 bg-red-500/20 rounded-lg border border-red-500/50">
                <p class="text-red-400 font-semibold mb-2">Wrong Answer!</p>
                <p class="text-gray-300 text-sm">You entered <span class="text-red-400 font-bold">${wrongAnswer}</span></p>
                <p class="text-gray-300 text-sm">Correct answer was <span class="text-green-400 font-bold">${correctAnswer}</span></p>
            </div>`;
    }
}

// -------------------------
// Save Score to RTDB
// -------------------------
async function saveScoreRTDB(success, time, steps, startNum) {
    if (!currentUser) {
        console.warn("User not logged in — skipping save.");
        return;
    }

    const db = firebaseRTDB;
    const scoreListRef = firebaseRTDBRef(db, `scores/${currentUser.uid}`);
    const newScoreRef = firebaseRTDBPush(scoreListRef);

    const data = {
        uid: currentUser.uid,
        displayName: currentUser.displayName || "Anonymous",
        startNumber: startNum,
        steps: steps,
        time: time,
        success: success,
        timestamp: Date.now()
    };

    try {
        await firebaseRTDBSet(newScoreRef, data);
        console.log("RTDB score saved:", data);
    } catch (err) {
        console.error("RTDB save failed:", err);
    }
}

// -------------------------
// Enter Key Submission
// -------------------------
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('answerInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') submitAnswer();
    });
});
