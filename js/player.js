import { db, isFirebaseConfigured } from './firebase-config.js';
import { limitToLast, onValue, orderByKey, push, query, ref, update, set } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { ROLES } from './utils.js';

const PHASE_LABELS = {
    WAITING: '等待房間',
    DAY_WAITING: '等待開始',
    NIGHT_WOLVES: '夜晚・狼人行動',
    NIGHT_GODS: '夜晚・神職行動',
    HUNTER_SHOT: '獵人・最後一槍',
    DAY_DISCUSSION: '白天・討論中',
    DAY_VOTING: '白天・投票中',
    DAY_RESULT: '白天・結果公布',
    LAST_WORDS: '出局・遺言時間',
    GAME_OVER: '遊戲結束'
};

function getPlayerStore() {
    const roomId = sessionStorage.getItem('werewolf_roomId');
    const playerName = sessionStorage.getItem('werewolf_playerName');
    const playerId = sessionStorage.getItem('werewolf_playerId');
    return { roomId, playerName, playerId };
}

function savePlayerSession(roomId, playerName, playerId) {
    sessionStorage.setItem('werewolf_roomId', roomId);
    sessionStorage.setItem('werewolf_playerName', playerName);
    sessionStorage.setItem('werewolf_playerId', playerId);
}

function nextAvailableSeat(players = {}) {
    const takenSeats = new Set(Object.values(players).map((player) => Number(player.seat)).filter((seat) => Number.isFinite(seat)));
    let seat = 1;
    while (takenSeats.has(seat)) seat += 1;
    return seat;
}

function renderPlayerList(players = {}, editablePlayerId = '') {
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
        item.innerHTML = `
            <span class="seat-label">${player.seat || '--'}</span>
            <span class="player-name">${player.name || '匿名玩家'}</span>
            <span class="mini-state ${player.isReady ? 'ready' : ''}">${player.isReady ? '準備' : '未準備'}</span>
        `;
        list.appendChild(item);
    });
}

function showPlayerActions(room, playerId, playerData, roleKey) {
    const actionContent = document.getElementById('action-content');
    const actionTitle = document.getElementById('action-title');
    const phase = room?.phase || 'WAITING';
    const alivePlayers = Object.values(room?.players || {}).filter((player) => player.isAlive !== false && player.seat !== playerData.seat);
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
        const buttons = buildChoiceButtons(alivePlayers.map((player) => ({
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
        const buttons = buildChoiceButtons(alivePlayers.map((player) => ({
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
            const actionButtons = document.createElement('div');
            actionButtons.className = 'action-list';

            const saveButton = document.createElement('button');
            saveButton.type = 'button';
            saveButton.className = `choice-button ${currentSaved ? 'selected' : ''}`;
            saveButton.textContent = antidoteUsed ? '解藥已用完' : currentSaved ? '本夜已選擇解藥' : targetSeat ? `使用解藥救回座位 ${targetSeat}` : '解藥可用';
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
                ? `本夜已選擇解藥，將救回座位 ${targetSeat}；毒藥不能同夜使用。`
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
        actionContent.innerHTML = '<p class="empty-row">請自由討論，確認要投票的對象。</p>';
        return;
    }

    if (phase === 'DAY_VOTING') {
        if (playerData.canVote === false) {
            actionContent.innerHTML = '<p class="empty-row">你已翻牌成為白癡，失去投票權。</p>';
            return;
        }
        const currentVote = Number(room.votes?.[playerId] || 0);
        const buttons = buildChoiceButtons(alivePlayers.map((player) => ({
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
        actionContent.innerHTML = `<p class="empty-row">${room.lastEvent || '白天結果已公布。'}</p>`;
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
            window.location.href = 'room.html';
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
    let stopWolfChatListener = null;
    let canUseWolfChat = false;
    roomHeading.textContent = playerName;

    const renderWolfChat = (snapshot) => {
        const messages = Object.entries(snapshot.val() || {});
        wolfChatList.replaceChildren();
        if (!messages.length) {
            const emptyMessage = document.createElement('li');
            emptyMessage.className = 'empty-row';
            emptyMessage.textContent = '尚無訊息，和狼人同伴討論戰術。';
            wolfChatList.appendChild(emptyMessage);
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
            wolfChatList.appendChild(item);
        });
        wolfChatList.scrollTop = wolfChatList.scrollHeight;
    };

    wolfChatForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = wolfChatInput.value.trim();
        if (!canUseWolfChat || !text) return;

        wolfChatSend.disabled = true;
        try {
            await set(push(wolfChatRef), {
                playerId: currentPlayerId,
                name: playerName,
                text: text.slice(0, 300),
                createdAt: Date.now()
            });
            wolfChatInput.value = '';
        } catch (error) {
            console.error('Failed to send wolf chat message:', error);
            messageBox.textContent = '狼人頻道訊息傳送失敗，請確認 Firebase 權限。';
        } finally {
            wolfChatSend.disabled = !canUseWolfChat || !wolfChatInput.value.trim();
        }
    });
    wolfChatInput.addEventListener('input', () => {
        wolfChatSend.disabled = !canUseWolfChat || !wolfChatInput.value.trim();
    });

    onValue(roomRef, async (snapshot) => {
        const room = snapshot.val();
        if (!room) {
            wolfChatPanel.hidden = true;
            stopWolfChatListener?.();
            stopWolfChatListener = null;
            messageBox.textContent = '找不到房間，請確認房號是否正確。';
            return;
        }

        const currentPlayer = room.players?.[currentPlayerId];
        const privateRole = room.privateRoles?.[currentPlayerId];
        canUseWolfChat = room.status === 'PLAYING' && privateRole === 'WEREWOLF' && currentPlayer?.isAlive !== false;
        wolfChatPanel.hidden = !canUseWolfChat;
        wolfChatInput.disabled = !canUseWolfChat;
        wolfChatSend.disabled = !canUseWolfChat || !wolfChatInput.value.trim();
        if (canUseWolfChat && !stopWolfChatListener) {
            stopWolfChatListener = onValue(query(wolfChatRef, orderByKey(), limitToLast(50)), renderWolfChat);
        } else if (!canUseWolfChat && stopWolfChatListener) {
            stopWolfChatListener();
            stopWolfChatListener = null;
            wolfChatList.replaceChildren();
        }

        if (room.status === 'ENDED') {
            const winnerText = room.lastEvent || '遊戲結束。';
            messageBox.textContent = `房間已結束，${winnerText}`;
            if (roleTitle) roleTitle.textContent = '遊戲結束';
            if (roleDescription) roleDescription.textContent = winnerText;
            if (revealButton) revealButton.hidden = true;
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

        renderPlayerList(room.players || {}, currentPlayerId);
        showPlayerActions(room, currentPlayerId, currentPlayer, privateRole || 'VILLAGER');

        const deadline = Number(room.phaseEndsAt || 0);
        if (deadline) {
            const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
            const ss = String(seconds % 60).padStart(2, '0');
            playerTimer.textContent = `${mm}:${ss}`;
        } else {
            playerTimer.textContent = '--:--';
        }

        messageBox.textContent = room.lastEvent || '等待房主開始遊戲。';
    });
});