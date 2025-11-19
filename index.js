// ==========================
// Collatz 1v1 Duel JS
// ==========================

// Game & duel state
let currentUser = null;
let duelID = null;
let startNumber = null;
let currentNum, stepCount;
let opponentData = { currentNumber: null, steps: 0 };
let timerInterval, startTime;
let sequence = [];
let duelRef = null;

// -------------------------
// Firebase Auth Listener
// -------------------------
firebaseOnAuthStateChanged(firebaseAuth, (user) => {
    currentUser = user;
    if (user) {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('duelLobby').classList.remove('hidden');
        document.getElementById('userInfo').textContent = `Signed in as: ${user.displayName || 'Anonymous'}`;
        document.getElementById('userInfo').classList.remove('hidden');
    } else {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('duelLobby').classList.add('hidden');
        document.getElementById('userInfo').classList.add('hidden');
    }
});

// -------------------------
// Login / Logout
// -------------------------
document.getElementById('loginBtn').addEventListener('click', async () => {
    try { await firebaseSignInWithPopup(firebaseAuth, firebaseProvider); }
    catch(err){ alert("Login failed. Check console."); console.error(err); }
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await firebaseSignOut(firebaseAuth); }
    catch(err){ alert("Logout failed. Check console."); console.error(err); }
});

// -------------------------
// Collatz Functions
// -------------------------
function collatzStep(n){ return n%2===0 ? n/2 : 3*n+1; }
function getTotalSteps(n){ let t=n,c=0; while(t!==1){ t=collatzStep(t); c++; } return c; }
function generateStartingNumber(){ while(true){ const n=Math.floor(Math.random()*100)+10; const s=getTotalSteps(n); if(s>=5 && s<=20) return n; }}

// -------------------------
// Duel Creation / Joining
// -------------------------
document.getElementById('createDuelBtn').addEventListener('click', async ()=>{
    startNumber = generateStartingNumber();
    const duelsRef = firebaseRTDBRef(firebaseRTDB,'duels');
    duelRef = firebaseRTDBPush(duelsRef);
    duelID = duelRef.key;

    await firebaseRTDBSet(duelRef,{
        startNumber,
        status:'pending',
        player1:{
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            currentNumber: startNumber,
            steps:0,
            finished:false
        }
    });

    document.getElementById('duelStatus').textContent=`Duel created! ID: ${duelID}. Waiting for opponent...`;
    listenDuel();
});

document.getElementById('joinDuelBtn').addEventListener('click', async ()=>{
    const inputID = document.getElementById('duelIDInput').value.trim();
    if(!inputID){ alert("Enter a duel ID"); return; }
    duelID = inputID;
    duelRef = firebaseRTDBRef(firebaseRTDB,`duels/${duelID}`);

    // Get start number from duel
    firebaseRTDBOnValue(duelRef, async snapshot=>{
        const data = snapshot.val();
        if(!data){ alert("Duel not found!"); duelID=null; return; }

        if(!data.player2 && data.status==='pending'){
            startNumber = data.startNumber;
            await firebaseRTDBSet(firebaseRTDBRef(firebaseRTDB,`duels/${duelID}/player2`),{
                uid:currentUser.uid,
                displayName:currentUser.displayName,
                currentNumber:startNumber,
                steps:0,
                finished:false
            });
            await firebaseRTDBSet(firebaseRTDBRef(firebaseRTDB,`duels/${duelID}/status`),'active');
            document.getElementById('duelStatus').textContent=`Joined duel ${duelID}. Game starting!`;
            startGame();
        } else if(data.status==='active'){
            alert("Duel already in progress!");
        } else{
            alert("Cannot join this duel.");
        }
    }, {once:true});
    listenDuel();
});

// -------------------------
// Listen for duel updates
// -------------------------
function listenDuel(){
    firebaseRTDBOnValue(duelRef, snapshot=>{
        const data = snapshot.val();
        if(!data) return;

        // Identify opponent
        let opponentKey = data.player1.uid===currentUser.uid?'player2':'player1';
        if(!data[opponentKey]) return;

        opponentData.currentNumber = data[opponentKey].currentNumber;
        opponentData.steps = data[opponentKey].steps;

        document.getElementById('opponentNumber').textContent = opponentData.currentNumber;
        document.getElementById('opponentStepCount').textContent = opponentData.steps;

        // Check if duel finished
        if(data.player1.finished && data.player2.finished){
            showResult(determineWinner(data));
        }
    });
}

// -------------------------
// Start Game
// -------------------------
function startGame(){
    currentNum=startNumber; stepCount=0; sequence=[currentNum];
    document.getElementById('duelLobby').classList.add('hidden');
    document.getElementById('gameScreen').classList.remove('hidden');
    document.getElementById('currentNumber').textContent=currentNum;
    document.getElementById('stepCount').textContent=stepCount;
    document.getElementById('answerInput').value='';
    document.getElementById('answerInput').disabled=false;
    document.getElementById('feedback').textContent='';
    startTime=Date.now();
    timerInterval=setInterval(updateTimer,100);
    setTimeout(()=>document.getElementById('answerInput').focus(),100);
}

// -------------------------
// Timer
// -------------------------
function updateTimer(){
    const elapsed = ((Date.now()-startTime)/1000).toFixed(1);
    document.getElementById('timer')?.textContent = elapsed+'s';
}

// -------------------------
// Submit Answer
// -------------------------
document.getElementById('submitBtn').addEventListener('click', submitAnswer);
document.getElementById('answerInput').addEventListener('keypress', e=>{if(e.key==='Enter') submitAnswer();});

async function submitAnswer(){
    const input = document.getElementById('answerInput');
    const answer = parseInt(input.value);
    const correct = collatzStep(currentNum);
    const feedback = document.getElementById('feedback');

    if(isNaN(answer)){ feedback.textContent='⚠️ Enter a number!'; feedback.className='text-yellow-400'; return; }

    if(answer!==correct){
        clearInterval(timerInterval);
        document.getElementById('answerInput').disabled=true;
        feedback.textContent=`✗ WRONG! (${currentNum} → ${correct})`;
        feedback.className='text-red-400';
        // mark finished in DB
        const playerKey = (await getPlayerKey());
        await firebaseRTDBUpdate(firebaseRTDBRef(firebaseRTDB,`duels/${duelID}/${playerKey}`),{finished:true});
        return;
    }

    // Correct
    currentNum=answer; stepCount++; sequence.push(currentNum);
    document.getElementById('currentNumber').textContent=currentNum;
    document.getElementById('stepCount').textContent=stepCount;

    // update RTDB
    const playerKey = await getPlayerKey();
    await firebaseRTDBUpdate(firebaseRTDBRef(firebaseRTDB,`duels/${duelID}/${playerKey}`),{
        currentNumber:currentNum,
        steps:stepCount
    });

    feedback.textContent='✓ Correct!'; feedback.className='text-green-400';
    input.value=''; input.focus();

    if(currentNum===1){
        clearInterval(timerInterval);
        await firebaseRTDBUpdate(firebaseRTDBRef(firebaseRTDB,`duels/${duelID}/${playerKey}`),{finished:true});
    }
}

// -------------------------
// Determine winner
// -------------------------
function determineWinner(duelData){
    const p1=duelData.player1; const p2=duelData.player2;
    if(!p1 || !p2) return null;
    if(p1.currentNumber===1 && p2.currentNumber===1){
        return (p1.steps<=p2.steps)?p1.displayName:p2.displayName;
    } else if(p1.currentNumber===1 || p1.finished){
        return p2.currentNumber===1 && !p2.finished?p2.displayName:p1.displayName;
    } else if(p2.currentNumber===1 || p2.finished){
        return p1.currentNumber===1 && !p1.finished?p1.displayName:p2.displayName;
    }
    return null;
}

// -------------------------
// Show Result
// -------------------------
function showResult(winner){
    document.getElementById('gameScreen').classList.add('hidden');
    document.getElementById('resultScreen').classList.remove('hidden');
    document.getElementById('resultTitle').textContent=winner?`Winner: ${winner}`:'Draw!';
    document.getElementById('resultEmoji').textContent=winner?'🏆':'🤝';
    document.getElementById('finalSteps').textContent=stepCount;
    document.getElementById('finalTime').textContent=((Date.now()-startTime)/1000).toFixed(1)+'s';
}

// -------------------------
// Return to Lobby
// -------------------------
function returnToLobby(){
    document.getElementById('resultScreen').classList.add('hidden');
    document.getElementById('duelLobby').classList.remove('hidden');
}

// -------------------------
// Helpers
// -------------------------
async function getPlayerKey(){
    const snap = await new Promise(resolve=>{
        firebaseRTDBOnValue(duelRef, s=>resolve(s.val()), {once:true});
    });
    return (snap.player1.uid===currentUser.uid)?'player1':'player2';
}
