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
    
    // Show countdown
    const countdown = $('currentNumber');
    const stepDisplay = $('stepCount');
    const answerInput = $('answerInput');
    const submitBtn = $('submitBtn');
    const feedback = $('feedback');
    const opponentNumberDisplay = $('opponentNumber');
    const opponentStepDisplay = $('opponentStepCount');
    
    // Disable input during countdown
    answerInput.disabled = true;
    submitBtn.disabled = true;
    feedback.textContent = '';
    stepDisplay.textContent = '0';
    
    // Change opponent label during countdown
    const opponentLabel = document.querySelector('#gameScreen .grid > div:nth-child(2) > p:first-child');
    const originalOpponentLabel = opponentLabel.textContent;
    opponentLabel.textContent = 'The Number';
    
    // 3 second countdown
    for(let i = 3; i > 0; i--) {
        countdown.textContent = i;
        countdown.className = 'text-6xl font-bold text-yellow-400 animate-pulse';
        opponentNumberDisplay.textContent = startNumber;
        stepDisplay.textContent = `Starting in ${i}...`;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Show "GO!"
    countdown.textContent = 'GO!';
    countdown.className = 'text-6xl font-bold text-green-400';
    opponentNumberDisplay.textContent = startNumber;
    opponentStepDisplay.textContent = '0';
    stepDisplay.textContent = 'GO!';
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Restore opponent label and set to question mark initially
    opponentLabel.textContent = originalOpponentLabel;
    opponentNumberDisplay.textContent = '?';
    
    // Start the actual game
    countdown.className = 'text-3xl font-bold text-yellow-400';
    countdown.textContent = currentNum;
    stepDisplay.textContent = stepCount;
    answerInput.value = '';
    answerInput.disabled = false;
    submitBtn.disabled = false;
    
    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 100);
    
    // Initialize sequence log
    updateSequenceLog();
    
    setTimeout(()=> answerInput.focus(), 100);
}
