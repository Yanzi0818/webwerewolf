import { db, isFirebaseConfigured } from './firebase-config.js';
import { onValue, ref, remove, runTransaction } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';
import { fisherYatesShuffle, ROLES } from './utils.js';

const PHASE_LABELS = {
	WAITING: '等待玩家',
	DAY_WAITING: '等待開始',
	NIGHT_WOLVES: '夜晚・狼人行動',
	NIGHT_GODS: '夜晚・神職行動',
	HUNTER_SHOT: '獵人・最後一槍',
	DAY_DISCUSSION: '白天・自由討論',
	DAY_VOTING: '白天・投票放逐',
	DAY_RESULT: '白天・公布結果',
	LAST_WORDS: '出局・遺言時間',
	GAME_OVER: '遊戲結束'
};

const PHASE_DURATIONS = {
	NIGHT_WOLVES: 45,
	NIGHT_GODS: 45,
	HUNTER_SHOT: 25,
	DAY_DISCUSSION: 60,
	DAY_VOTING: 30,
	DAY_RESULT: 12,
	LAST_WORDS: 30
};

function renderRoleSkillReference() {
	const list = document.getElementById('role-skill-list');
	list.replaceChildren(...Object.values(ROLES).map((role) => {
		const item = document.createElement('article');
		item.className = 'role-skill-entry';
		const heading = document.createElement('h3');
		const faction = document.createElement('p');
		const description = document.createElement('p');
		heading.textContent = `${role.icon} ${role.name}`;
		faction.className = 'role-skill-faction';
		faction.textContent = role.faction;
		description.textContent = role.description;
		item.append(heading, faction, description);
		return item;
	}));
}

function defaultRoleCounts(playerCount) {
	const counts = {
		WEREWOLF: Math.max(1, Math.floor(playerCount / 3)),
		SEER: 1,
		WITCH: 1,
		HUNTER: playerCount >= 8 ? 1 : 0,
		IDIOT: playerCount >= 9 ? 1 : 0,
		VILLAGER: 0
	};
	counts.VILLAGER = Math.max(0, playerCount - Object.entries(counts).reduce((total, [role, count]) => total + (role === 'VILLAGER' ? 0 : count), 0));
	return counts;
}

function buildRoleDeck(playerCount, roleCounts = defaultRoleCounts(playerCount)) {
	const roleKeys = ['WEREWOLF', 'SEER', 'WITCH', 'HUNTER', 'IDIOT', 'VILLAGER'];
	const counts = Object.fromEntries(roleKeys.map((role) => [role, Number(roleCounts?.[role] || 0)]));
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	if (counts.WEREWOLF < 1 || Object.values(counts).some((count) => !Number.isInteger(count) || count < 0) || total !== playerCount) {
		return null;
	}
	return fisherYatesShuffle(roleKeys.flatMap((role) => Array(counts[role]).fill(role)));
}

function createRoleConfigurationController(onSaved, onChange) {
	const fieldset = document.getElementById('role-configuration');
	const wolfCountInput = document.getElementById('werewolf-count');
	const villagerCountInput = document.getElementById('villager-count');
	const specialRoleInputs = [...document.querySelectorAll('[data-role-toggle]')];
	const roleQuantityInputs = [...document.querySelectorAll('[data-role-quantity]')];
	const roleCountStatus = document.getElementById('role-count-status');
	const roleConfigState = document.getElementById('role-config-state');
	const roleConfigMessage = document.getElementById('role-config-message');
	const saveButton = document.getElementById('save-role-config');
	const roleKeys = ['WEREWOLF', 'SEER', 'WITCH', 'HUNTER', 'IDIOT', 'VILLAGER'];
	let playerCount = 0;
	let savedSignature = '';
	let loadedSignature = '';
	let editable = false;
	let saving = false;

	const getConfiguredRoleCounts = () => {
		const counts = Object.fromEntries(roleQuantityInputs.map((input) => [input.dataset.roleQuantity, Number(input.value)]));
		for (const input of specialRoleInputs) counts[input.dataset.roleToggle] = input.checked ? 1 : 0;
		return counts;
	};
	const getSignature = (counts) => roleKeys.map((role) => Number(counts[role] || 0)).join(':');
	const isValid = (counts) => Object.values(counts).every((count) => Number.isInteger(count) && count >= 0)
		&& counts.WEREWOLF >= 1
		&& Object.values(counts).reduce((sum, count) => sum + count, 0) === playerCount;

	const updateControls = (changedInput = null) => {
		if (!playerCount) return;
		let counts = getConfiguredRoleCounts();
		if (changedInput?.matches('[data-role-toggle]') && changedInput.checked) {
			const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
			if (total > playerCount) changedInput.checked = false;
			counts = getConfiguredRoleCounts();
		}
		if (changedInput?.matches('[data-role-quantity]')) {
			const role = changedInput.dataset.roleQuantity;
			const others = Object.entries(counts).reduce((sum, [key, count]) => sum + (key === role ? 0 : count), 0);
			const minimum = role === 'WEREWOLF' ? 1 : 0;
			const maximum = Math.max(minimum, playerCount - others);
			const value = Number(changedInput.value);
			changedInput.value = String(Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? Math.trunc(value) : minimum)));
			counts = getConfiguredRoleCounts();
		}

		const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
		for (const input of specialRoleInputs) input.disabled = !input.checked && total >= playerCount;
		for (const input of roleQuantityInputs) {
			const role = input.dataset.roleQuantity;
			const others = Object.entries(counts).reduce((sum, [key, count]) => sum + (key === role ? 0 : count), 0);
			input.max = String(Math.max(role === 'WEREWOLF' ? 1 : 0, playerCount - others));
		}

		const valid = isValid(counts);
		const dirty = getSignature(counts) !== savedSignature;
		roleCountStatus.textContent = total === playerCount
			? `角色數量 ${total} / ${playerCount}，配置完成。`
			: `角色數量 ${total} / ${playerCount}，還可選 ${Math.max(0, playerCount - total)} 個。`;
		roleCountStatus.classList.toggle('is-complete', valid);
		roleConfigState.textContent = saving ? '儲存中' : dirty ? '尚未儲存' : '已儲存';
		roleConfigMessage.textContent = editable ? '調整角色後請儲存，再開始遊戲。' : '遊戲進行中或已結束時無法修改角色。';
		saveButton.disabled = !editable || saving || !valid || !dirty;
		onChange({ valid, dirty });
	};

	const applyCounts = (counts) => {
		wolfCountInput.value = String(counts.WEREWOLF);
		villagerCountInput.value = String(counts.VILLAGER);
		for (const input of specialRoleInputs) input.checked = Number(counts[input.dataset.roleToggle]) > 0;
	};

	for (const input of [...specialRoleInputs, ...roleQuantityInputs]) {
		input.addEventListener('change', () => updateControls(input));
		input.addEventListener('input', () => updateControls(input));
	}
	fieldset.disabled = true;
	saveButton.addEventListener('click', async () => {
		const counts = getConfiguredRoleCounts();
		if (!editable || !isValid(counts)) return;
		saving = true;
		updateControls();
		try {
			const saved = await onSaved(counts);
			if (saved) savedSignature = getSignature(counts);
			else roleConfigMessage.textContent = '儲存失敗，請確認房間仍在等待狀態後重試。';
		} catch (error) {
			console.error('Failed to save role configuration:', error);
			roleConfigMessage.textContent = '儲存失敗，請確認 Firebase 連線後重試。';
		} finally {
			saving = false;
			updateControls();
		}
	});

	return {
		load(nextPlayerCount, roleCounts, canEdit) {
			playerCount = Number(nextPlayerCount);
			const defaults = defaultRoleCounts(playerCount);
			const normalizedCounts = Object.fromEntries(roleKeys.map((role) => [role, Number(roleCounts?.[role] ?? defaults[role])]));
			const signature = getSignature(normalizedCounts);
			if (signature !== loadedSignature) {
				applyCounts(normalizedCounts);
				savedSignature = signature;
				loadedSignature = signature;
			}
			editable = Boolean(canEdit);
			fieldset.disabled = !editable;
			updateControls();
		},
		isReady() {
			const counts = getConfiguredRoleCounts();
			return editable && isValid(counts) && getSignature(counts) === savedSignature && !saving;
		}
	};
}

function getPhaseDuration(room, phase) {
	const configuredDuration = Number(room.settings?.phaseDurations?.[phase]);
	if (Number.isInteger(configuredDuration) && configuredDuration >= 5 && configuredDuration <= 600) {
		return configuredDuration;
	}
	return PHASE_DURATIONS[phase] || 0;
}

function createPhaseTimeController(onSaved) {
	const fieldset = document.getElementById('phase-time-fields');
	const inputs = [...document.querySelectorAll('[data-phase-duration]')];
	const state = document.getElementById('phase-time-state');
	const message = document.getElementById('phase-time-message');
	const saveButton = document.getElementById('save-phase-times');
	const phaseKeys = Object.keys(PHASE_DURATIONS);
	let savedSignature = '';
	let loadedSignature = '';
	let editable = false;
	let saving = false;

	const getValues = () => Object.fromEntries(inputs.map((input) => [input.dataset.phaseDuration, Number(input.value)]));
	const getSignature = (values) => phaseKeys.map((phase) => values[phase]).join(':');
	const isValid = (values) => phaseKeys.every((phase) => Number.isInteger(values[phase]) && values[phase] >= 5 && values[phase] <= 600);
	const updateState = () => {
		const values = getValues();
		const dirty = getSignature(values) !== savedSignature;
		state.textContent = saving ? '儲存中' : dirty ? '尚未儲存' : '已儲存';
		message.textContent = editable ? '開始遊戲前可調整每個階段的倒數時間。' : '遊戲進行中或已結束時無法修改階段時間。';
		saveButton.disabled = !editable || saving || !isValid(values) || !dirty;
	};

	fieldset.disabled = true;
	for (const input of inputs) {
		input.addEventListener('input', updateState);
		input.addEventListener('change', updateState);
	}
	saveButton.addEventListener('click', async () => {
		const values = getValues();
		if (!editable || !isValid(values)) return;
		saving = true;
		updateState();
		try {
			const saved = await onSaved(values);
			if (saved) savedSignature = getSignature(values);
			else message.textContent = '儲存失敗，請確認房間仍在等待狀態後重試。';
		} catch (error) {
			console.error('Failed to save phase durations:', error);
			message.textContent = '儲存失敗，請確認 Firebase 連線後重試。';
		} finally {
			saving = false;
			updateState();
		}
	});

	return {
		load(durations, canEdit) {
			const normalized = Object.fromEntries(phaseKeys.map((phase) => {
				const value = Number(durations?.[phase] ?? PHASE_DURATIONS[phase]);
				return [phase, Number.isInteger(value) && value >= 5 && value <= 600 ? value : PHASE_DURATIONS[phase]];
			}));
			const signature = getSignature(normalized);
			if (signature !== loadedSignature) {
				for (const input of inputs) input.value = String(normalized[input.dataset.phaseDuration]);
				savedSignature = signature;
				loadedSignature = signature;
			}
			editable = Boolean(canEdit);
			fieldset.disabled = !editable;
			updateState();
		}
	};
}

function generateRoomId() {
	return String(Math.floor(1000 + Math.random() * 9000));
}

function showMessage(message) {
	const messageElement = document.getElementById('form-message');
	if (messageElement) {
		messageElement.textContent = message;
	} else {
		window.alert(message);
	}
}

function countLivingPlayers(players) {
	return Object.values(players || {}).filter((player) => player.isAlive !== false).length;
}

function findPlayerIdBySeat(players, seat) {
	const normalizedSeat = Number(seat);
	if (!Number.isFinite(normalizedSeat) || normalizedSeat <= 0) return null;
	for (const [playerId, player] of Object.entries(players || {})) {
		if (player.isAlive !== false && Number(player.seat) === normalizedSeat) return playerId;
	}
	return null;
}

function resolveNight(room) {
	const players = { ...(room.players || {}) };
	const actions = room.nightActions || {};
	const deaths = new Set();
	const requestedWolfTarget = Number(actions.wolfKillTarget || 0);
	const wolfTargetSeat = findPlayerIdBySeat(players, requestedWolfTarget) ? requestedWolfTarget : 0;
	const potions = {
		antidoteUsed: Boolean(room.witchPotions?.antidoteUsed),
		poisonUsed: Boolean(room.witchPotions?.poisonUsed)
	};
	const requestedPoisonTarget = Number(actions.witchPoisonTarget || 0);
	const poisonTargetSeat = !actions.witchSave && !potions.poisonUsed && findPlayerIdBySeat(players, requestedPoisonTarget)
		? requestedPoisonTarget
		: 0;
	const seerTargetSeat = Number(actions.seerCheckTarget || 0);
	const witchSaved = Boolean(actions.witchSave) && !potions.antidoteUsed && !actions.witchPoisonTarget && wolfTargetSeat > 0;
	const hunterPlayerId = wolfTargetSeat && !witchSaved
		? Object.entries(players).find(([playerId, player]) => player.isAlive !== false
			&& room.privateRoles?.[playerId] === 'HUNTER'
			&& Number(player.seat) === wolfTargetSeat)?.[0] || null
		: null;

	if (wolfTargetSeat && !witchSaved) deaths.add(wolfTargetSeat);
	if (poisonTargetSeat) deaths.add(poisonTargetSeat);

	const deadNames = [];
	const deadPlayerIds = [];
	for (const [playerId, player] of Object.entries(players)) {
		if (player.isAlive !== false && deaths.has(Number(player.seat))) {
			players[playerId] = { ...player, isAlive: false };
			deadNames.push(player.name);
			deadPlayerIds.push(playerId);
		}
	}

	potions.antidoteUsed ||= witchSaved;
	potions.poisonUsed ||= Boolean(poisonTargetSeat);

	let seerSummary = '預言家未查驗。';
	if (seerTargetSeat) {
		const seerTarget = Object.entries(players).find(([, player]) => Number(player.seat) === seerTargetSeat && player.isAlive !== false);
		if (seerTarget) {
			const targetPlayerId = seerTarget[0];
			const targetRole = room.privateRoles?.[targetPlayerId] || 'VILLAGER';
			seerSummary = `${seerTarget[1].name}（座位 ${seerTargetSeat}）${targetRole === 'WEREWOLF' ? '是狼人。' : '不是狼人。'}`;
		}
	}

	const summaries = [];
	if (wolfTargetSeat) {
		summaries.push(witchSaved ? `狼人襲擊目標 ${wolfTargetSeat}，女巫使用解藥救回。` : `狼人襲擊目標 ${wolfTargetSeat}。`);
	}
	if (poisonTargetSeat) summaries.push(`女巫毒殺座位 ${poisonTargetSeat}。`);
	if (!deadNames.length) summaries.push('昨夜平安夜，無人出局。');
	if (deadNames.length) summaries.push(`昨夜出局：${deadNames.join('、')}。`);

	return {
		players,
		witchPotions: potions,
		hunterPlayerId,
		deadPlayerIds,
		message: `${seerSummary} ${summaries.join(' ')}`.trim()
	};
}

function resolveVote(room) {
	const players = { ...(room.players || {}) };
	const counts = new Map();
	for (const [playerId, targetSeat] of Object.entries(room.votes || {})) {
		const voter = players[playerId];
		if (!voter || voter.isAlive === false || voter.canVote === false) continue;
		const seat = Number(targetSeat);
		if (seat) counts.set(seat, (counts.get(seat) || 0) + 1);
	}

	const highestVotes = Math.max(0, ...counts.values());
	const leaders = [...counts.entries()].filter(([, votes]) => votes === highestVotes);
	if (highestVotes === 0 || leaders.length !== 1) {
		return { players, deadPlayerIds: [], hunterPlayerId: null, message: '平票或無有效票數，今日無人出局。' };
	}

	const targetSeat = leaders[0][0];
	const target = Object.entries(players).find(([, player]) => player.isAlive !== false && Number(player.seat) === targetSeat);
	if (!target) return { players, deadPlayerIds: [], hunterPlayerId: null, message: '今日無人出局。' };
	const targetPlayerId = target[0];
	const targetRole = room.privateRoles?.[targetPlayerId];
	if (targetRole === 'IDIOT' && !players[targetPlayerId].idiotSaved) {
		players[targetPlayerId] = {
			...players[targetPlayerId],
			isAlive: true,
			idiotSaved: true,
			canVote: false
		};
		return { players, deadPlayerIds: [], hunterPlayerId: null, message: `投票放逐：${target[1].name}（${highestVotes} 票），白癡翻牌免死，失去投票權。` };
	}
	players[target[0]] = { ...target[1], isAlive: false };
	return {
		players,
		deadPlayerIds: [targetPlayerId],
		hunterPlayerId: targetRole === 'HUNTER' ? targetPlayerId : null,
		message: `投票放逐：${target[1].name}（${highestVotes} 票）`
	};
}

function queueLastWords(room, playerIds, nextPhase) {
	const queue = [...new Set(playerIds || [])].filter((playerId) => room.players?.[playerId]?.isAlive === false && !room.kickedPlayers?.[playerId]);
	if (!queue.length) return { ...room, phase: nextPhase };

	const firstSpeaker = room.players[queue[0]];
	return {
		...room,
		phase: 'LAST_WORDS',
		lastWordsQueue: queue,
		lastWordsIndex: 0,
		lastWordsPlayerId: queue[0],
		nextPhaseAfterLastWords: nextPhase,
		lastEvent: `${firstSpeaker.name}（座位 ${firstSpeaker.seat}）正在遺言。`
	};
}


function hasGameWinner(players, privateRoles) {
	let wolves = 0;
	let villagers = 0;
	for (const [playerId, player] of Object.entries(players || {})) {
		if (player.isAlive === false) continue;
		if (privateRoles?.[playerId] === 'WEREWOLF') wolves += 1;
		else villagers += 1;
	}
	if (wolves === 0) return '好人陣營獲勝。';
	if (wolves >= villagers) return '狼人陣營獲勝。';
	return null;
}

async function startGame(roomRef, room) {
	const playerEntries = Object.entries(room.players || {}).sort(([, first], [, second]) => first.seat - second.seat);
	const expectedCount = Number(room.settings?.playerCount || 0);
	if (playerEntries.length !== expectedCount || playerEntries.some(([, player]) => !player.isReady)) {
		showMessage('需等滿設定人數，且所有玩家都按下準備。');
		return;
	}

	const result = await runTransaction(roomRef, (currentRoom) => {
		if (!currentRoom || currentRoom.status !== 'WAITING') return;
		const currentPlayers = Object.entries(currentRoom.players || {}).sort(([, first], [, second]) => first.seat - second.seat);
		if (currentPlayers.length !== expectedCount || currentPlayers.some(([, player]) => !player.isReady)) return;

		const deck = buildRoleDeck(currentPlayers.length, currentRoom.settings?.roleCounts);
		if (!deck) return;
		const players = {};
		const privateRoles = {};
		currentPlayers.forEach(([playerId, player], index) => {
			players[playerId] = { ...player, isAlive: true, idiotSaved: false, canVote: true, hunterCanShoot: false };
			privateRoles[playerId] = deck[index];
			if (deck[index] === 'HUNTER') players[playerId].hunterCanShoot = true;
		});

		return {
			...currentRoom,
			status: 'PLAYING',
			phase: 'NIGHT_WOLVES',
			phaseEndsAt: Date.now() + getPhaseDuration(currentRoom, 'NIGHT_WOLVES') * 1000,
			players,
			privateRoles,
			nightActions: { wolfKillTarget: null, witchSave: false, witchPoisonTarget: null, seerCheckTarget: null, hunterShotTarget: null },
			witchPotions: { antidoteUsed: false, poisonUsed: false },
			pendingHunterId: null,
			phaseAfterHunterShot: null,
			pendingLastWordsQueue: null,
			lastWordsQueue: null,
			lastWordsIndex: null,
			lastWordsPlayerId: null,
			nextPhaseAfterLastWords: null,
			votes: {},
			lastEvent: '遊戲開始，請所有玩家確認底牌。'
		};
	});
	if (result.committed) {
		await remove(ref(db, `wolfChats/${roomRef.key}`));
		await remove(ref(db, `dayChats/${roomRef.key}`));
	} else {
		showMessage('無法開始，請確認人數、準備狀態與房間狀態。');
	}
}

async function restartGame(roomRef) {
	const result = await runTransaction(roomRef, (room) => {
		if (!room || room.status !== 'ENDED') return;

		const { privateRoles, votes, nightActions, witchPotions, phaseEndsAt, lastEvent, pendingHunterId, phaseAfterHunterShot, lastWordsQueue, lastWordsIndex, lastWordsPlayerId, nextPhaseAfterLastWords, ...waitingRoom } = room;
		const players = Object.fromEntries(Object.entries(room.players || {}).map(([playerId, player]) => [
			playerId,
			{ ...player, isAlive: true, isReady: false, idiotSaved: false, canVote: true, hunterCanShoot: false }
		]));

		return {
			...waitingRoom,
			status: 'WAITING',
			phase: 'DAY_WAITING',
			players,
			nightActions: { wolfKillTarget: null, witchSave: false, witchPoisonTarget: null, seerCheckTarget: null, hunterShotTarget: null },
			witchPotions: { antidoteUsed: false, poisonUsed: false },
			pendingHunterId: null,
			phaseAfterHunterShot: null,
			pendingLastWordsQueue: null,
			lastWordsQueue: null,
			lastWordsIndex: null,
			lastWordsPlayerId: null,
			nextPhaseAfterLastWords: null,
			votes: {},
			lastEvent: '上一局已結束，請所有玩家重新準備。'
		};
	});
	if (result.committed) {
		await remove(ref(db, `wolfChats/${roomRef.key}`));
		await remove(ref(db, `dayChats/${roomRef.key}`));
	}
	return result.committed;
}

async function kickPlayer(roomRef, playerId) {
	const result = await runTransaction(roomRef, (room) => {
		const player = room?.players?.[playerId];
		if (!player) return;

		const seat = Number(player.seat);
		let nextRoom = {
			...room,
			players: { ...room.players },
			kickedPlayers: { ...(room.kickedPlayers || {}), [playerId]: true }
		};
		if (room.status === 'PLAYING') {
			nextRoom.players[playerId] = { ...player, isAlive: false, isReady: false, canVote: false, kicked: true };
		} else {
			delete nextRoom.players[playerId];
		}

		const votes = { ...(room.votes || {}) };
		for (const [voterId, targetSeat] of Object.entries(votes)) {
			if (voterId === playerId || Number(targetSeat) === seat) delete votes[voterId];
		}
		nextRoom.votes = votes;

		const actions = { ...(room.nightActions || {}) };
		for (const actionKey of ['wolfKillTarget', 'witchPoisonTarget', 'seerCheckTarget', 'hunterShotTarget']) {
			if (Number(actions[actionKey]) === seat) actions[actionKey] = null;
		}
		if (!actions.wolfKillTarget) actions.witchSave = false;
		nextRoom.nightActions = actions;
		nextRoom.lastEvent = `${player.name} 已被房主踢出房間。`;

		if (room.status !== 'PLAYING') return nextRoom;

		if (room.phase === 'HUNTER_SHOT' && room.pendingHunterId === playerId) {
			const afterShotPhase = room.phaseAfterHunterShot || 'DAY_RESULT';
			const remainingDeaths = (room.pendingLastWordsQueue || []).filter((id) => id !== playerId);
			const { pendingHunterId, phaseAfterHunterShot, pendingLastWordsQueue, ...roomWithoutHunter } = nextRoom;
			nextRoom = queueLastWords(roomWithoutHunter, remainingDeaths, afterShotPhase);
			nextRoom.phaseEndsAt = Date.now() + getPhaseDuration(nextRoom, nextRoom.phase) * 1000;
		}

		if (nextRoom.phase === 'LAST_WORDS' && nextRoom.lastWordsQueue?.includes(playerId)) {
			const remainingQueue = nextRoom.lastWordsQueue.filter((id) => id !== playerId);
			if (!remainingQueue.length) {
				const { lastWordsQueue, lastWordsIndex, lastWordsPlayerId, nextPhaseAfterLastWords, ...roomWithoutWords } = nextRoom;
				nextRoom = { ...roomWithoutWords, phase: nextPhaseAfterLastWords || 'DAY_RESULT' };
				nextRoom.phaseEndsAt = Date.now() + getPhaseDuration(nextRoom, nextRoom.phase) * 1000;
			} else {
				const currentSpeakerIndex = remainingQueue.indexOf(nextRoom.lastWordsPlayerId);
				if (currentSpeakerIndex >= 0) {
					nextRoom.lastWordsQueue = remainingQueue;
					nextRoom.lastWordsIndex = currentSpeakerIndex;
				} else {
					nextRoom = queueLastWords(nextRoom, remainingQueue, nextRoom.nextPhaseAfterLastWords || 'DAY_RESULT');
					nextRoom.phaseEndsAt = Date.now() + getPhaseDuration(nextRoom, 'LAST_WORDS') * 1000;
				}
			}
		}

		const winner = nextRoom.phase === 'HUNTER_SHOT' || nextRoom.phase === 'LAST_WORDS'
			? null
			: hasGameWinner(nextRoom.players, nextRoom.privateRoles);
		if (winner) {
			nextRoom.status = 'ENDED';
			nextRoom.phase = 'GAME_OVER';
			nextRoom.phaseEndsAt = 0;
			nextRoom.lastEvent = winner;
		}
		return nextRoom;
	});
	return result.committed;
}

async function advancePhase(roomRef) {
	const result = await runTransaction(roomRef, (room) => {
		if (!room || room.status !== 'PLAYING') return;

		let nextRoom = { ...room };
		let nextPhase;
		if (room.phase === 'NIGHT_WOLVES') {
			nextPhase = 'NIGHT_GODS';
			nextRoom.lastEvent = '狼人已選擇目標，現在輪到神職角色行動。';
		} else if (room.phase === 'NIGHT_GODS') {
			const resolution = resolveNight(room);
			nextRoom.players = resolution.players;
			nextRoom.witchPotions = resolution.witchPotions;
			nextRoom.lastEvent = resolution.message;
			if (resolution.hunterPlayerId) {
				nextRoom.pendingHunterId = resolution.hunterPlayerId;
				nextRoom.phaseAfterHunterShot = 'DAY_DISCUSSION';
				nextRoom.pendingLastWordsQueue = resolution.deadPlayerIds;
				nextPhase = 'HUNTER_SHOT';
			} else {
				nextRoom = queueLastWords(nextRoom, resolution.deadPlayerIds, 'DAY_DISCUSSION');
				nextPhase = nextRoom.phase;
			}
		} else if (room.phase === 'DAY_DISCUSSION') {
			nextPhase = 'DAY_VOTING';
		} else if (room.phase === 'DAY_VOTING') {
			const resolution = resolveVote(room);
			nextRoom.players = resolution.players;
			nextRoom.lastEvent = resolution.message;
			if (resolution.hunterPlayerId) {
				nextRoom.pendingHunterId = resolution.hunterPlayerId;
				nextRoom.phaseAfterHunterShot = 'DAY_RESULT';
				nextRoom.pendingLastWordsQueue = resolution.deadPlayerIds;
				nextPhase = 'HUNTER_SHOT';
			} else {
				nextRoom = queueLastWords(nextRoom, resolution.deadPlayerIds, 'DAY_RESULT');
				nextPhase = nextRoom.phase;
			}
		} else if (room.phase === 'HUNTER_SHOT') {
			const targetSeat = Number(room.nightActions?.hunterShotTarget || 0);
			const targetPlayerId = findPlayerIdBySeat(nextRoom.players, targetSeat);
			const hunterId = room.pendingHunterId;
			const hunter = hunterId ? nextRoom.players[hunterId] : null;
			const deadPlayerIds = [...(room.pendingLastWordsQueue || [])];
			if (targetPlayerId && hunter && room.privateRoles?.[hunterId] === 'HUNTER') {
				nextRoom.players[targetPlayerId] = { ...nextRoom.players[targetPlayerId], isAlive: false };
				deadPlayerIds.push(targetPlayerId);
				nextRoom.lastEvent = `獵人 ${hunter.name} 開槍帶走 ${nextRoom.players[targetPlayerId].name}。`;
			} else {
				nextRoom.lastEvent = `獵人 ${hunter?.name || ''} 沒有開槍。`;
			}
			const afterShotPhase = room.phaseAfterHunterShot || 'DAY_RESULT';
			const { pendingHunterId, phaseAfterHunterShot, pendingLastWordsQueue, ...roomWithoutPendingHunter } = nextRoom;
			nextRoom = roomWithoutPendingHunter;
			nextRoom.nightActions = { ...room.nightActions, hunterShotTarget: null };
			nextRoom = queueLastWords(nextRoom, deadPlayerIds, afterShotPhase);
			nextPhase = nextRoom.phase;
		} else if (room.phase === 'LAST_WORDS') {
			const queue = room.lastWordsQueue || [];
			const nextIndex = Number(room.lastWordsIndex || 0) + 1;
			if (nextIndex < queue.length) {
				const nextPlayerId = queue[nextIndex];
				const speaker = room.players?.[nextPlayerId];
				nextRoom.lastWordsIndex = nextIndex;
				nextRoom.lastWordsPlayerId = nextPlayerId;
				nextRoom.lastEvent = `${speaker?.name || '出局玩家'}（座位 ${speaker?.seat || '--'}）正在遺言。`;
				nextPhase = 'LAST_WORDS';
			} else {
				const { lastWordsQueue, lastWordsIndex, lastWordsPlayerId, nextPhaseAfterLastWords, ...roomWithoutLastWords } = nextRoom;
				nextRoom = { ...roomWithoutLastWords, lastEvent: '遺言時間結束。' };
				nextPhase = room.nextPhaseAfterLastWords || 'DAY_RESULT';
			}
		} else if (room.phase === 'DAY_RESULT') {
			nextRoom.nightActions = { wolfKillTarget: null, witchSave: false, witchPoisonTarget: null, seerCheckTarget: null, hunterShotTarget: null };
			nextRoom.votes = {};
			nextPhase = 'NIGHT_WOLVES';
			nextRoom.lastEvent = '新的一夜開始，請先進入狼人行動階段。';
		} else {
			return;
		}

		const winner = nextPhase === 'HUNTER_SHOT' || nextPhase === 'LAST_WORDS'
			? null
			: hasGameWinner(nextRoom.players, nextRoom.privateRoles);
		if (winner) {
			nextPhase = 'GAME_OVER';
			nextRoom.status = 'ENDED';
			nextRoom.lastEvent = winner;
		}
		nextRoom.phase = nextPhase;
		nextRoom.phaseEndsAt = Date.now() + getPhaseDuration(nextRoom, nextPhase) * 1000;
		return nextRoom;
	});
	return result.committed;
}

function initHostDashboard() {
	const roomId = new URLSearchParams(window.location.search).get('room');
	const roomCode = document.getElementById('room-code');
	const statusElement = document.getElementById('game-status');
	const phaseTitle = document.getElementById('phase-title');
	const timerElement = document.getElementById('phase-timer');
	const playerList = document.getElementById('player-list');
	const emptyPlayers = document.getElementById('empty-players');
	const startButton = document.getElementById('start-game');
	const advanceButton = document.getElementById('advance-phase');
	const restartButton = document.getElementById('restart-game');
	const clearRoomButton = document.getElementById('clear-room');
	const messageElement = document.getElementById('host-message');
	const connectionNote = document.getElementById('connection-note');
	const lastEvent = document.getElementById('last-event');
	let currentRoom = null;
	let currentDeadline = 0;
	let transitionPending = false;

	if (!roomId) {
		connectionNote.textContent = '網址缺少房間號碼，請從建立房間流程進入。';
		return;
	}
	roomCode.textContent = roomId;
	renderRoleSkillReference();
	if (!isFirebaseConfigured) {
		connectionNote.textContent = '請先在 js/firebase-config.js 填入 Firebase 專案設定。';
		return;
	}

	const roomRef = ref(db, `rooms/${roomId}`);
	const roleConfiguration = createRoleConfigurationController(async (roleCounts) => {
		const result = await runTransaction(roomRef, (room) => {
			if (!room || room.status !== 'WAITING') return;
			const total = Object.values(roleCounts).reduce((sum, count) => sum + count, 0);
			if (total !== Number(room.settings?.playerCount || 0) || roleCounts.WEREWOLF < 1) return;
			return { ...room, settings: { ...room.settings, roleCounts } };
		});
		return result.committed;
	}, () => {
		if (currentRoom) {
			const players = Object.values(currentRoom.players || {});
			const readyCount = players.filter((player) => player.isReady).length;
			startButton.disabled = players.length !== Number(currentRoom.settings?.playerCount || 0)
				|| readyCount !== players.length
				|| !roleConfiguration.isReady();
		}
	});
	const phaseTimeConfiguration = createPhaseTimeController(async (phaseDurations) => {
		const result = await runTransaction(roomRef, (room) => {
			if (!room || room.status !== 'WAITING') return;
			if (Object.values(phaseDurations).some((duration) => !Number.isInteger(duration) || duration < 5 || duration > 600)) return;
			return { ...room, settings: { ...room.settings, phaseDurations } };
		});
		return result.committed;
	});
	document.getElementById('copy-room-code').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(roomId);
			messageElement.textContent = '房號已複製。';
		} catch {
			messageElement.textContent = `房號：${roomId}`;
		}
	});
	startButton.addEventListener('click', () => currentRoom && startGame(roomRef, currentRoom));
	restartButton.addEventListener('click', async () => {
		restartButton.disabled = true;
		const restarted = await restartGame(roomRef);
		if (!restarted) messageElement.textContent = '重新開局失敗，請確認房間仍在遊戲結束狀態。';
		restartButton.disabled = false;
	});
	advanceButton.addEventListener('click', async () => {
		transitionPending = true;
		await advancePhase(roomRef);
		transitionPending = false;
	});
	clearRoomButton.addEventListener('click', async () => {
		const confirmed = window.confirm('確定要清空這個房間資料嗎？這會刪除所有玩家與遊戲狀態。');
		if (!confirmed) return;
		await remove(roomRef);
		await remove(ref(db, `wolfChats/${roomId}`));
		await remove(ref(db, `dayChats/${roomId}`));
		window.location.href = 'setting.html';
	});

	onValue(roomRef, (snapshot) => {
		currentRoom = snapshot.val();
		if (!currentRoom) {
			connectionNote.textContent = '找不到這個房間。';
			return;
		}
		connectionNote.textContent = '';
		const playerEntries = Object.entries(currentRoom.players || {}).sort(([, first], [, second]) => first.seat - second.seat);
		const players = playerEntries.map(([, player]) => player);
		const capacity = Number(currentRoom.settings?.playerCount || 0);
		const readyCount = players.filter((player) => player.isReady).length;
		const playing = currentRoom.status === 'PLAYING';
		const phase = currentRoom.phase || 'WAITING';
		const phaseDeadline = Number(currentRoom.phaseEndsAt || 0);
		roleConfiguration.load(capacity, currentRoom.settings?.roleCounts, currentRoom.status === 'WAITING');
		phaseTimeConfiguration.load(currentRoom.settings?.phaseDurations, currentRoom.status === 'WAITING');
		if (currentDeadline !== phaseDeadline) currentDeadline = phaseDeadline;

		statusElement.textContent = currentRoom.status === 'ENDED' ? '已結束' : playing ? '進行中' : '等待中';
		phaseTitle.textContent = PHASE_LABELS[phase] || phase;
		document.getElementById('player-count-label').textContent = `${players.length} / ${capacity}`;
		document.getElementById('ready-count').textContent = `${readyCount} 人準備`;
		lastEvent.textContent = currentRoom.lastEvent || '尚無遊戲結果。';
		messageElement.textContent = playing ? '依照階段提示，引導玩家完成行動。' : `等待 ${capacity} 位玩家加入，全部準備後即可發牌。`;
		startButton.hidden = playing || currentRoom.status === 'ENDED';
		restartButton.hidden = currentRoom.status !== 'ENDED';
		startButton.disabled = players.length !== capacity || readyCount !== capacity || !roleConfiguration.isReady();
		advanceButton.disabled = !playing;
		advanceButton.hidden = !playing;
		playerList.replaceChildren(...playerEntries.map(([playerId, player]) => {
			const item = document.createElement('li');
			const seat = document.createElement('strong');
			const name = document.createElement('span');
			const role = document.createElement('span');
			const state = document.createElement('span');
			const kickButton = document.createElement('button');
			seat.textContent = String(player.seat).padStart(2, '0');
			name.textContent = player.name;
			const roleKey = currentRoom.privateRoles?.[playerId];
			role.className = 'player-role';
			role.textContent = roleKey ? ROLES[roleKey]?.name || roleKey : '未發牌';
			state.className = `player-state${player.isAlive === false ? ' is-dead' : ''}`;
			state.textContent = player.kicked
				? '已踢出'
				: player.isAlive === false
				? playerId === currentRoom.lastWordsPlayerId ? '遺言中' : '出局'
				: playing ? '在場' : player.isReady ? '已準備' : '未準備';
			kickButton.type = 'button';
			kickButton.className = 'btn btn-danger btn-compact kick-player-button';
			kickButton.textContent = '踢出';
			kickButton.title = `踢出 ${player.name}`;
			kickButton.addEventListener('click', async () => {
				if (!window.confirm(`確定要踢出 ${player.name} 嗎？`)) return;
				kickButton.disabled = true;
				const kicked = await kickPlayer(roomRef, playerId);
				if (!kicked) {
					messageElement.textContent = '踢出失敗，玩家可能已離開房間。';
					kickButton.disabled = false;
				}
			});
			item.append(seat, name, role, state, kickButton);
			return item;
		}));
		emptyPlayers.hidden = players.length > 0;
	});

	setInterval(async () => {
		if (!currentRoom || !currentDeadline) {
			timerElement.textContent = '--:--';
			return;
		}
		const seconds = Math.max(0, Math.ceil((currentDeadline - Date.now()) / 1000));
		timerElement.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
		if (seconds === 0 && currentRoom.status === 'PLAYING' && !transitionPending) {
			transitionPending = true;
			await advancePhase(roomRef);
			transitionPending = false;
		}
	}, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
	if (document.getElementById('host-dashboard')) {
		initHostDashboard();
		return;
	}

	const form = document.getElementById('create-room-form');
	if (!form) return;

	const roomIdInput = document.getElementById('room-id');
	const generateButton = document.getElementById('generate-room-id');
	const createButton = document.getElementById('create-room');
	const playerCountInput = document.getElementById('player-count');

	roomIdInput.value = generateRoomId();

	generateButton.addEventListener('click', () => {
		roomIdInput.value = generateRoomId();
	});

	form.addEventListener('submit', async (event) => {
		event.preventDefault();

		if (!form.reportValidity()) return;
		const playerCount = Number(playerCountInput.value);
		if (!isFirebaseConfigured) {
			showMessage('請先在 js/firebase-config.js 填入 Firebase 專案設定。');
			return;
		}

		const roomId = roomIdInput.value.trim();
		const roomRef = ref(db, `rooms/${roomId}`);
		createButton.disabled = true;
		showMessage('正在建立房間…');

		try {
			const result = await runTransaction(roomRef, (existingRoom) => {
				if (existingRoom !== null) return;

				return {
					roomId,
					status: 'WAITING',
					phase: 'DAY_WAITING',
					settings: {
						preset: document.getElementById('preset').value,
						playerCount,
						roleCounts: defaultRoleCounts(playerCount),
						phaseDurations: { ...PHASE_DURATIONS },
						speechTime: Number(document.getElementById('speech-time').value)
					},
					players: {},
					kickedPlayers: {},
					nightActions: {
						wolfKillTarget: null,
						witchSave: false,
						witchPoisonTarget: null,
						seerCheckTarget: null,
						hunterShotTarget: null
					}
				};
			});

			if (!result.committed) {
				showMessage('這個房號已經有人使用，請重新產生房號。');
				return;
			}

			window.location.href = `host.html?room=${encodeURIComponent(roomId)}`;
		} catch (error) {
			console.error('Failed to create room:', error);
			showMessage('建立房間失敗，請確認 Firebase 設定與資料庫權限後重試。');
		} finally {
			createButton.disabled = false;
		}
	});
});
