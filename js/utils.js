export const ROLES = {
	WEREWOLF: {
		name: '狼人',
		faction: '狼人陣營',
		icon: '🐺',
		description: '每晚與狼人同伴選擇一名玩家襲擊。'
	},
	SEER: {
		name: '預言家',
		faction: '好人陣營',
		icon: '🔮',
		description: '每晚查驗一名玩家，得知其是否為狼人。'
	},
	WITCH: {
		name: '女巫',
		faction: '好人陣營',
		icon: '🧪',
		description: '持有一瓶解藥與一瓶毒藥，每種藥整局限用一次，且每晚最多使用一種。'
	},
	HUNTER: {
		name: '獵人',
		faction: '好人陣營',
		icon: '🏹',
		description: '被狼人或投票擊殺時，可在最後一刻開槍擊殺一名活著的玩家。'
	},
	IDIOT: {
		name: '白癡',
		faction: '好人陣營',
		icon: '🤹',
		description: '第一次被投票放逐時可翻牌免死，之後存活但失去投票權。'
	},
	VILLAGER: {
		name: '村民',
		faction: '好人陣營',
		icon: '🧑‍🌾',
		description: '沒有夜間技能，透過觀察與討論找出狼人。'
	}
};

export function fisherYatesShuffle(array) {
	const shuffled = [...array];

	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(Math.random() * (index + 1));
		[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
	}

	return shuffled;
}
