import { db, isFirebaseConfigured } from './firebase-config.js';
import { limitToLast, onValue, orderByKey, push, query, ref, update, set } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { ROLES } from './utils.js';

const PHASE_LABELS = {
    WAITING: '等待房間',
    DAY_WAITING: '等待開始',
    NIGHT_WOLVES: '夜晚・狼人行動',
    NIGHT_GODS: '夜晚・神職行動',
    HUNTER_SHOT: '獵人・最後一槍',
    DAY_DISCUSSION: '白天・輪流發言',
    DAY_VOTING: '白天・投票中',
    DAY_RESULT: '白天・結果公布',
    LAST_WORDS: '出局・遺言時間',
    GAME_OVER: '遊戲結束'
};

function getPlayerStore() {
    const params = new URLSearchParams(window.location.search);
    const roomId = sessionStorage.getItem('werewolf_roomId') || params.get('room');
    const playerId = sessionStorage.getItem('werewolf_playerId') || params.get('player');
    let playerName = sessionStorage.getItem('werewolf_playerName');
    if (!playerName && roomId && playerId) {
        try {
            const savedPlayer = JSON.parse(localStorage.getItem(`werewolf-player:${roomId}:${playerId}`) || 'null');
            playerName = savedPlayer?.playerName || '';
        } catch {
            playerName = '';
        }
    }
    if (roomId && playerName && playerId) savePlayerSession(roomId, playerName, playerId);
    return { roomId, playerName, playerId };
}

function savePlayerSession(roomId, playerName, playerId) {
    sessionStorage.setItem('werewolf_roomId', roomId);
    sessionStorage.setItem('werewolf_playerName', playerName);
    sessionStorage.setItem('werewolf_playerId', playerId);
    try {
        localStorage.setItem(`werewolf-player:${roomId}:${playerId}`, JSON.stringify({ roomId, playerName, playerId }));
    } catch {
        // The active tab can still resume through sessionStorage if persistent storage is unavailable.
    }
}

function nextAvailableSeat(players = {}) {
    const takenSeats = new Set(Object.values(players).map((player) => Number(player.seat)).filter((seat) => Number.isFinite(seat)));
    let seat = 1;
    while (takenSeats.has(seat)) seat += 1;
    return seat;
}

function renderPlayerList(players = {}, editablePlayerId = '', room = {}) {
    const list = document.getElementById('room-player-list');
    if (!list) return;

    const entries = Object.entries(players).sort(([, first], [, second]) => Number(first.seat || 0) - Number(second.seat || 0));
    list.innerHTML = '';

    if (!entries.length) {
        list.innerHTML = '<li class="empty-row">尚未有人加入房間</li>';
        return;
    }

    entries.forEach(([playerId, player]) => {
        const item = document.createElement('li');
        item.className = 'player-mini-card';
        if (playerId === editablePlayerId) item.classList.add('is-me');
        if (player.kicked) item.classList.add('is-dead');
        const seat = document.createElement('span');
        const name = document.createElement('span');
        const state = document.createElement('span');
        seat.className = 'seat-label';
        seat.textContent = String(player.seat || '--');
        name.className = 'player-name';
        name.textContent = player.name || '匿名玩家';
        state.className = 'mini-state';
        if (player.kicked) {
            state.textContent = '已踢出';
        } else if (player.isAlive === false) {
            state.textContent = '已出局';
            state.classList.add('is-dead');
        } else if (room.status === 'PLAYING' && room.phase === 'DAY_DISCUSSION' && room.currentSpeakerId === playerId) {
            state.textContent = '發言中';
            state.classList.add('is-speaking');
        } else if (room.status === 'PLAYING' || room.status === 'ENDED') {
            state.textContent = '存活';
        } else {
            state.textContent = player.isReady ? '準備' : '未準備';
            if (player.isReady) state.classList.add('ready');
        }
        item.append(seat, name, state);
        list.appendChild(item);
    });
}

function appendVoteResults(container, room) {
    const voteEntries = Object.entries(room.votes || {});
    if (!voteEntries.length) return;

    const section = document.createElement('section');
    section.className = 'vote-results';
    const heading = document.createElement('h3');
    heading.textContent = '本輪投票結果';
    const tally = new Map();
    voteEntries.forEach(([, targetSeat]) => {
        const seat = Number(targetSeat);
        if (seat > 0) tally.set(seat, (tally.get(seat) || 0) + 1);
    });
    const list = document.createElement('ul');
    list.className = 'vote-result-list';

    if (room.settings?.anonymousVoting) {
        [...tally.entries()].sort(([first], [second]) => first - second).forEach(([seat, count]) => {
            const target = Object.values(room.players || {}).find((player) => Number(player.seat) === seat);
            const item = document.createElement('li');
            item.textContent = `${target?.name || '未知玩家'}（座位 ${seat}）：${count} 票`;
            list.appendChild(item);
        });
        const note = document.createElement('p');
        note.className = 'panel-copy';
        note.textContent = '本局為匿名投票，僅顯示各玩家票數。';
        section.append(heading, list, note);
    } else {
        const totals = document.createElement('li');
        totals.className = 'vote-result-total';
        totals.textContent = [...tally.entries()]
            .sort(([first], [second]) => first - second)
            .map(([seat, count]) => {
                const target = Object.values(room.players || {}).find((player) => Number(player.seat) === seat);
                return `${target?.name || '未知玩家'} ${count} 票`;
            }).join('、') || '沒有有效票數。';
        list.appendChild(totals);
        voteEntries.forEach(([voterId, targetSeat]) => {
            const voter = room.players?.[voterId];
            const target = Object.values(room.players || {}).find((player) => Number(player.seat) === Number(targetSeat));
            if (!voter || !target) return;
            const item = document.createElement('li');
            item.textContent = `${voter.name} → ${target.name}`;
            list.appendChild(item);
        });
        section.append(heading, list);
    }
    container.appendChild(section);
}

function showPlayerActions(room, playerId, playerData, roleKey) {
    const actionContent = document.getElementById('action-content');
    const actionTitle = document.getElementById('action-title');
    const phase = room?.phase || 'WAITING';
    const alivePlayers = Object.values(room?.players || {}).filter((player) => player.isAlive !== false && Number(player.seat) !== Number(playerData.seat));
    const allAlivePlayers = Object.values(room?.players || {}).filter((player) => player.isAlive !== false && !player.kicked);
    const buildChoiceButtons = (options, onClick, lockOnSelection = false, disabled = false) => {
        const container = document.createElement('div');
        container.className = 'action-list';
        const selectionLocked = lockOnSelection && options.some((option) => option.selected);
        options.forEach(({ label, value, selected = false }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `choice-button ${selected ? 'selected' : ''}`;
            button.textContent = label;
            button.disabled = selectionLocked || disabled;
            button.addEventListener('click', () => onClick(value));
            container.appendChild(button);
        });
        return container;
    };

    actionContent.innerHTML = '';
    actionTitle.textContent = PHASE_LABELS[phase] || '等待中';

    if (room?.status !== 'PLAYING') {
        actionContent.innerHTML = '<p class="empty-row">房主尚未開始遊戲。</p>';
        return;
    }

    if (phase === 'LAST_WORDS') {
        const speaker = room.players?.[room.lastWordsPlayerId];
        const message = room.lastWordsPlayerId === playerId
            ? '現在是你的遺言時間，請在時間內完成發言。'
            : `現在是 ${speaker?.name || '出局玩家'}（座位 ${speaker?.seat || '--'}）的遺言時間。`;
        actionContent.innerHTML = '';
        const note = document.createElement('p');
        note.className = 'empty-row last-words-notice';
        note.textContent = message;
        actionContent.appendChild(note);
        return;
    }

    if (phase === 'HUNTER_SHOT') {
        if (roleKey !== 'HUNTER' || room.pendingHunterId !== playerId || playerData?.isAlive !== false) {
            actionContent.innerHTML = '<p class="empty-row">獵人正在選擇最後一槍。</p>';
            return;
        }

        const currentTarget = Number(room.nightActions?.hunterShotTarget || 0);
        const buttons = buildChoiceButtons(allAlivePlayers.map((player) => ({
            label: `${player.name}（座位 ${player.seat}）`,
            value: Number(player.seat),
            selected: currentTarget === Number(player.seat)
        })), async (seat) => {
            await update(ref(db, `rooms/${room.roomId}/nightActions`), { hunterShotTarget: seat });
        });

        actionContent.appendChild(buttons);

        const note = document.createElement('p');
        note.className = 'empty-row';
        note.textContent = currentTarget
            ? `你已選擇最後一槍擊殺座位 ${currentTarget}。`
            : '請選擇一位玩家作為最後一槍；不選擇則直接結束此階段。';
        actionContent.appendChild(note);
        return;
    }

    if (playerData?.isAlive === false) {
        actionContent.innerHTML = '<p class="empty-row">你已出局，請等待下一輪或觀看其他玩家動作。</p>';
        return;
    }

    if (phase === 'NIGHT_WOLVES') {
        if (roleKey !== 'WEREWOLF') {
            actionContent.innerHTML = '<p class="empty-row">請等待狼人選擇目標。</p>';
            return;
        }

        const currentTarget = Number(room.nightActions?.wolfKillTarget);
        const buttons = buildChoiceButtons(allAlivePlayers.map((player) => ({
            label: `${player.name}（座位 ${player.seat}）`,
            value: Number(player.seat),
            selected: currentTarget === Number(player.seat)
        })), async (seat) => {
            await update(ref(db, `rooms/${room.roomId}/nightActions`), { wolfKillTarget: seat });
        });
        actionContent.appendChild(buttons);
        return;
    }

    if (phase === 'NIGHT_GODS') {
        if (roleKey === 'SEER') {
            const currentTarget = Number(room.nightActions?.seerCheckTarget);
            const buttons = buildChoiceButtons(alivePlayers.map((player) => ({
                label: `${player.name}（座位 ${player.seat}）`,
                value: Number(player.seat),
                selected: currentTarget === Number(player.seat)
            })), async (seat) => {
                await update(ref(db, `rooms/${room.roomId}/nightActions`), { seerCheckTarget: seat });
            }, true);
            actionContent.appendChild(buttons);

            const target = alivePlayers.find((player) => Number(player.seat) === currentTarget);
            const result = target
                ? `${target.name}（座位 ${target.seat}）${room.privateRoles?.[Object.keys(room.players || {}).find((playerId) => room.players[playerId].seat === target.seat)] === 'WEREWOLF' ? '是狼人。' : '不是狼人。'}`
                : '請選擇一位玩家查驗。';

            const note = document.createElement('p');
            note.className = 'empty-row';
            note.textContent = currentTarget ? `本夜已完成查驗。${result}` : result;
            actionContent.appendChild(note);
            return;
        }

        if (roleKey === 'WITCH') {
            const targetSeat = Number(room.nightActions?.wolfKillTarget || 0);
            const currentSaved = Boolean(room.nightActions?.witchSave);
            const poisonTarget = Number(room.nightActions?.witchPoisonTarget || 0);
            const potions = room.witchPotions || {};
            const antidoteUsed = Boolean(potions.antidoteUsed);
            const poisonUsed = Boolean(potions.poisonUsed);
            const isSelfTarget = targetSeat === Number(playerData.seat);
            const actionButtons = document.createElement('div');
            actionButtons.className = 'action-list';

            const saveButton = document.createElement('button');
            saveButton.type = 'button';
            saveButton.className = `choice-button ${currentSaved ? 'selected' : ''}`;
            saveButton.textContent = antidoteUsed
                ? '解藥已用完'
                : currentSaved
                    ? '本夜已選擇解藥'
                    : isSelfTarget
                        ? `使用解藥自救（座位 ${targetSeat}）`
                        : targetSeat ? `使用解藥救回座位 ${targetSeat}` : '解藥可用';
            saveButton.disabled = antidoteUsed || currentSaved || Boolean(poisonTarget) || !targetSeat;
            saveButton.addEventListener('click', async () => {
                if (!targetSeat) {
                    window.alert('目前沒有狼人襲擊目標可救。');
                    return;
                }
                await update(ref(db, `rooms/${room.roomId}/nightActions`), { witchSave: true });
            });

            actionButtons.appendChild(saveButton);
            actionContent.appendChild(actionButtons);

            const poisonChoices = buildChoiceButtons(alivePlayers.map((player) => ({
                label: `${player.name}（座位 ${player.seat}）`,
                value: Number(player.seat),
                selected: poisonTarget === Number(player.seat)
            })), async (seat) => {
                await update(ref(db, `rooms/${room.roomId}/nightActions`), { witchPoisonTarget: seat });
            }, true, poisonUsed || currentSaved);
            actionContent.appendChild(poisonChoices);

            const potionStatus = `解藥${antidoteUsed ? '已用完' : '可用'}；毒藥${poisonUsed ? '已用完' : '可用'}。`;
            const actionStatus = currentSaved
                ? `本夜已選擇解藥，將${isSelfTarget ? '自救' : `救回座位 ${targetSeat}`}；毒藥不能同夜使用。`
                : poisonTarget
                    ? `本夜已選擇毒殺座位 ${poisonTarget}；解藥不能同夜使用。`
                    : targetSeat
                        ? `狼人目標是座位 ${targetSeat}，本夜只能選擇一種藥水。`
                        : '目前沒有狼人目標，仍可選擇一名玩家使用毒藥。';

            const status = document.createElement('p');
            status.className = 'empty-row';
            status.textContent = `${potionStatus} ${actionStatus}`;
            actionContent.appendChild(status);
            return;
        }

        actionContent.innerHTML = '<p class="empty-row">請等待其他神職完成夜間行動。</p>';
        return;
    }

    if (phase === 'DAY_DISCUSSION') {
        const speaker = room.players?.[room.currentSpeakerId];
        const note = document.createElement('p');
        note.className = 'empty-row';
        note.textContent = room.currentSpeakerId === playerId
            ? `現在輪到你發言，剩餘時間請看倒數計時。`
            : `目前由 ${speaker?.name || '玩家'}（座位 ${speaker?.seat || '--'}）發言，請依序等待。`;
        actionContent.appendChild(note);
        return;
    }

    if (phase === 'DAY_VOTING') {
        if (playerData.canVote === false) {
            actionContent.innerHTML = '<p class="empty-row">你已翻牌成為白癡，失去投票權。</p>';
            return;
        }
        const currentVote = Number(room.votes?.[playerId] || 0);
        const buttons = buildChoiceButtons(allAlivePlayers.map((player) => ({
            label: `${player.name}（座位 ${player.seat}）`,
            value: Number(player.seat),
            selected: currentVote === Number(player.seat)
        })), async (seat) => {
            await update(ref(db, `rooms/${room.roomId}/votes`), { [playerId]: seat });
        });
        actionContent.appendChild(buttons);
        return;
    }

    if (phase === 'DAY_RESULT') {
        const event = document.createElement('p');
        event.className = 'empty-row';
        event.textContent = room.lastEvent || '白天結果已公布。';
        actionContent.appendChild(event);
        appendVoteResults(actionContent, room);
        return;
    }

    actionContent.innerHTML = '<p class="empty-row">請等待下一個階段開始。</p>';
}

document.addEventListener('DOMContentLoaded', async () => {
    const joinForm = document.getElementById('join-form');
    if (joinForm) {
        joinForm.addEventListener('submit', (event) => {
            event.preventDefault();

            const roomInput = document.getElementById('room-id');
            const nameInput = document.getElementById('player-name');
            const roomId = roomInput?.value.trim();
            const playerName = nameInput?.value.trim();

            if (!/^\d{4}$/.test(roomId || '') || !playerName) {
                window.alert('請輸入 4 位數房號，並填寫玩家暱稱。');
                return;
            }

            const playerId = `${roomId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            savePlayerSession(roomId, playerName, playerId);
            const roomParams = new URLSearchParams({ room: roomId, player: playerId });
            window.location.href = `room.html?${roomParams.toString()}`;
        });
        return;
    }

    const isRoomPage = !!document.getElementById('player-app');
    if (!isRoomPage) {
        return;
    }

    const { roomId, playerName, playerId } = getPlayerStore();
    const roomHeading = document.getElementById('player-heading');
    const phaseLabel = document.getElementById('player-phase');
    const messageBox = document.getElementById('player-message');
    const readyButton = document.getElementById('ready-button');
    const revealButton = document.getElementById('reveal-role');
    const roleTitle = document.getElementById('role-title');
    const roleDescription = document.getElementById('role-description');
    const playerSeat = document.getElementById('player-seat');
    const playerTimer = document.getElementById('player-timer');
    const wolfChatPanel = document.getElementById('wolf-chat-panel');
    const wolfChatList = document.getElementById('wolf-chat-messages');
    const wolfChatForm = document.getElementById('wolf-chat-form');
    const wolfChatInput = document.getElementById('wolf-chat-input');
    const wolfChatSend = document.getElementById('wolf-chat-send');
    const dayChatPanel = document.getElementById('day-chat-panel');
    const dayChatList = document.getElementById('day-chat-messages');
    const dayChatForm = document.getElementById('day-chat-form');
    const dayChatInput = document.getElementById('day-chat-input');
    const dayChatSend = document.getElementById('day-chat-send');
    const finalRolesPanel = document.getElementById('final-roles-panel');
    const finalRolesList = document.getElementById('final-roles-list');

    if (!roomId || !playerName) {
        if (messageBox) {
            messageBox.textContent = '請先從首頁輸入房號與暱稱，再進入遊戲。';
        }
        return;
    }

    if (!isFirebaseConfigured) {
        messageBox.textContent = '請先在 js/firebase-config.js 填入 Firebase 專案設定。';
        return;
    }

    const currentPlayerId = playerId || crypto.randomUUID();
    sessionStorage.setItem('werewolf_playerId', currentPlayerId);

    const roomRef = ref(db, `rooms/${roomId}`);
    const playerRef = ref(db, `rooms/${roomId}/players/${currentPlayerId}`);
    const wolfChatRef = ref(db, `wolfChats/${roomId}`);
    const dayChatRef = ref(db, `dayChats/${roomId}`);
    let stopWolfChatListener = null;
    let stopDayChatListener = null;
    let canUseWolfChat = false;
    let canUseDayChat = false;
    let currentDeadline = 0;
    roomHeading.textContent = playerName;

    const renderChatMessages = (snapshot, list, emptyText) => {
        const messages = Object.entries(snapshot.val() || {});
        list.replaceChildren();
        if (!messages.length) {
            const emptyMessage = document.createElement('li');
            emptyMessage.className = 'empty-row';
            emptyMessage.textContent = emptyText;
            list.appendChild(emptyMessage);
            return;
        }

        messages.forEach(([, message]) => {
            const item = document.createElement('li');
            item.className = 'wolf-chat-message';
            const header = document.createElement('header');
            const name = document.createElement('strong');
            const time = document.createElement('time');
            const text = document.createElement('p');
            const timestamp = Number(message.createdAt);
            name.textContent = message.name || '狼人';
            time.textContent = Number.isFinite(timestamp)
                ? new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
                : '';
            text.textContent = message.text || '';
            header.append(name, time);
            item.append(header, text);
            list.appendChild(item);
        });
        list.scrollTop = list.scrollHeight;
    };

    const bindChatForm = (form, input, button, chatRef, canSend, channelName) => {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const text = input.value.trim();
            if (!canSend() || !text) return;

            button.disabled = true;
            try {
                await set(push(chatRef), {
                    playerId: currentPlayerId,
                    name: playerName,
                    text: text.slice(0, 300),
                    createdAt: Date.now()
                });
                input.value = '';
            } catch (error) {
                console.error(`Failed to send ${channelName} message:`, error);
                messageBox.textContent = `${channelName}訊息傳送失敗，請確認 Firebase 權限。`;
            } finally {
                button.disabled = !canSend() || !input.value.trim();
            }
        });
        input.addEventListener('input', () => {
            button.disabled = !canSend() || !input.value.trim();
        });
    };

    bindChatForm(wolfChatForm, wolfChatInput, wolfChatSend, wolfChatRef, () => canUseWolfChat, '狼人頻道');
    bindChatForm(dayChatForm, dayChatInput, dayChatSend, dayChatRef, () => canUseDayChat, '白天對話');

    const setChatAccess = (wolfAccess, dayAccess, daySendAccess = dayAccess) => {
        canUseWolfChat = wolfAccess;
        canUseDayChat = daySendAccess;
        wolfChatPanel.hidden = !wolfAccess;
        wolfChatInput.disabled = !wolfAccess;
        wolfChatSend.disabled = !wolfAccess || !wolfChatInput.value.trim();
        dayChatPanel.hidden = !dayAccess;
        dayChatInput.disabled = !daySendAccess;
        dayChatSend.disabled = !daySendAccess || !dayChatInput.value.trim();

        if (wolfAccess && !stopWolfChatListener) {
            stopWolfChatListener = onValue(query(wolfChatRef, orderByKey(), limitToLast(50)), (snapshot) => {
                renderChatMessages(snapshot, wolfChatList, '尚無訊息，和狼人同伴討論戰術。');
            });
        } else if (!wolfAccess && stopWolfChatListener) {
            stopWolfChatListener();
            stopWolfChatListener = null;
            wolfChatList.replaceChildren();
        }

        if (dayAccess && !stopDayChatListener) {
            stopDayChatListener = onValue(query(dayChatRef, orderByKey(), limitToLast(50)), (snapshot) => {
                renderChatMessages(snapshot, dayChatList, '尚無訊息，開始白天討論吧。');
            });
        } else if (!dayAccess && stopDayChatListener) {
            stopDayChatListener();
            stopDayChatListener = null;
            dayChatList.replaceChildren();
        }
    };

    const refreshPlayerTimer = () => {
        if (!currentDeadline) {
            playerTimer.textContent = '--:--';
            return;
        }
        const seconds = Math.max(0, Math.ceil((currentDeadline - Date.now()) / 1000));
        playerTimer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    setInterval(refreshPlayerTimer, 1000);
    document.addEventListener('visibilitychange', refreshPlayerTimer);

    onValue(roomRef, async (snapshot) => {
        const room = snapshot.val();
        if (!room) {
            currentDeadline = 0;
            refreshPlayerTimer();
            setChatAccess(false, false);
            wolfChatPanel.hidden = true;
            stopWolfChatListener?.();
            stopWolfChatListener = null;
            messageBox.textContent = '找不到房間，請確認房號是否正確。';
            return;
        }

        currentDeadline = Number(room.phaseEndsAt || 0);
        refreshPlayerTimer();
        const currentPlayer = room.players?.[currentPlayerId];
        const privateRole = room.privateRoles?.[currentPlayerId];
        if (room.kickedPlayers?.[currentPlayerId]) {
            setChatAccess(false, false);
            readyButton.disabled = true;
            revealButton.hidden = true;
            document.getElementById('action-content').replaceChildren();
            messageBox.textContent = '你已被房主移出房間。';
            return;
        }
        const activePlayer = Boolean(currentPlayer) && currentPlayer.isAlive !== false && !currentPlayer.kicked;
        const canUseWolfChannel = room.status === 'PLAYING'
            && ['NIGHT_WOLVES', 'NIGHT_GODS'].includes(room.phase)
            && privateRole === 'WEREWOLF'
            && activePlayer;
        const canUsePublicChat = room.status === 'PLAYING' && room.phase === 'DAY_DISCUSSION' && activePlayer;
        const canSpeakPublicly = canUsePublicChat && room.currentSpeakerId === currentPlayerId;
        setChatAccess(canUseWolfChannel, canUsePublicChat, canSpeakPublicly);
        renderPlayerList(room.players || {}, currentPlayerId, room);

        finalRolesPanel.hidden = room.status !== 'ENDED';
        if (room.status === 'ENDED') {
            finalRolesList.replaceChildren(...Object.entries(room.players || {})
                .sort(([, first], [, second]) => Number(first.seat) - Number(second.seat))
                .map(([playerId, player]) => {
                    const item = document.createElement('li');
                    item.className = 'player-mini-card';
                    const seat = document.createElement('span');
                    const name = document.createElement('span');
                    const role = document.createElement('span');
                    seat.className = 'seat-label';
                    seat.textContent = String(player.seat || '--');
                    name.className = 'player-name';
                    name.textContent = player.name || '匿名玩家';
                    role.className = 'mini-state';
                    role.textContent = ROLES[room.privateRoles?.[playerId]]?.name || '未知職業';
                    item.append(seat, name, role);
                    return item;
                }));
        }

        if (room.status === 'ENDED') {
            const winnerText = room.lastEvent || '遊戲結束。';
            messageBox.textContent = `房間已結束，${winnerText}`;
            phaseLabel.textContent = PHASE_LABELS.GAME_OVER;
            if (roleTitle) roleTitle.textContent = '遊戲結束';
            if (roleDescription) roleDescription.textContent = winnerText;
            if (revealButton) revealButton.hidden = true;
            const actionContent = document.getElementById('action-content');
            actionContent.replaceChildren();
            document.getElementById('action-title').textContent = PHASE_LABELS.GAME_OVER;
            const event = document.createElement('p');
            event.className = 'empty-row';
            event.textContent = winnerText;
            actionContent.appendChild(event);
            appendVoteResults(actionContent, room);
            return;
        }

        if (!currentPlayer) {
            const seat = nextAvailableSeat(room.players);
            await set(playerRef, {
                name: playerName,
                seat,
                isAlive: true,
                isReady: false,
                role: null
            });
            return;
        }

        const localSeat = Number(currentPlayer.seat || 0);
        playerSeat.textContent = localSeat ? String(localSeat) : '--';
        readyButton.disabled = room.status === 'PLAYING' || room.status === 'ENDED';
        readyButton.textContent = currentPlayer.isReady ? '已準備' : '準備';
        readyButton.onclick = async () => {
            await update(playerRef, { isReady: !currentPlayer.isReady });
        };
        phaseLabel.textContent = PHASE_LABELS[room.phase] || room.phase;

        const roleMeta = privateRole ? ROLES[privateRole] : null;
        if (roleMeta) {
            roleTitle.textContent = '底牌已發';
            roleDescription.textContent = '點擊查看底牌，揭示你的角色。';
            revealButton.hidden = false;
            revealButton.textContent = '查看底牌';
            revealButton.onclick = () => {
                roleTitle.textContent = roleMeta.name;
                roleDescription.textContent = `${roleMeta.icon} ${roleMeta.faction}：${roleMeta.description}`;
                revealButton.hidden = true;
            };
        } else {
            roleTitle.textContent = '尚未發牌';
            roleDescription.textContent = '房主開始遊戲後，身份會出現在這裡。';
            revealButton.hidden = true;
        }

        showPlayerActions(room, currentPlayerId, currentPlayer, privateRole || 'VILLAGER');

        messageBox.textContent = room.lastEvent || '等待房主開始遊戲。';
    });
});