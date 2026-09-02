import {
	Color,
	dotaunitorder_t,
	Entity,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	InputManager,
	Item,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	TempTree,
	TickSleeper,
	Tree,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

const CUT_ITEMS = ["item_quelling_blade", "item_bfury", "item_iron_talon", "item_tango", "item_tango_single"]

new (class AutoSproutBreaker {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode("Auto Tree Breaker", "furion_sprout")

	private readonly enabled = this.node.AddToggle(
		"Enable Auto Tree Breaker",
		true,
		"Automatically cut/eat Sprout trees, Hoodwink Acorn trees, and Branch traps"
	)

	private readonly cutSprout = this.node.AddToggle(
		"Auto Sprout Breaker (Nature's Prophet)",
		true,
		"Cuts Sprout trees in the direction the hero is walking to exit instantly"
	)

	private readonly cutHoodwinkAcorn = this.node.AddToggle(
		"Auto Cut Hoodwink Acorn Trees",
		true,
		"Instantly cuts Hoodwink Acorn Shot trees near hero to counter Bushwhack stun and bounce"
	)

	private readonly cutIronwoodBranch = this.node.AddToggle(
		"Auto Cut Enemy Branch Trees",
		true,
		"Cuts Ironwood Branch (GG branch) trees planted near hero to block paths"
	)

	private readonly onlySproutTrees = this.node.AddToggle(
		"Only Cut Temporary Trees (TempTree)",
		true,
		"Only cuts temporary trees spawned by Sprout / Acorn / Branches, ignoring normal jungle trees"
	)

	private readonly itemSelector = this.node.AddImageSelector(
		"Allowed Items",
		CUT_ITEMS,
		new Map([
			["item_quelling_blade", true],
			["item_bfury", true],
			["item_iron_talon", true],
			["item_tango", true],
			["item_tango_single", true]
		]),
		"Items allowed to cut or eat trees"
	)

	private readonly directionMode = this.node.AddDropdown(
		"Tree Cut Direction",
		["Hero Movement Direction", "Mouse Cursor Direction", "Closest Tree"],
		0,
		"Select which tree to cut: the one in the hero's walking path, toward cursor, or closest"
	)

	private readonly autoWalkOut = this.node.AddToggle(
		"Auto Walk Out After Cut",
		true,
		"Re-issues movement order right after cutting the tree so the hero exits seamlessly"
	)

	private readonly drawIndicator = this.node.AddToggle(
		"Draw Target Tree Indicator",
		true,
		"Draws a visual green indicator ring around the tree chosen for cutting"
	)

	private readonly sleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	private lastMoveTargetPos: Vector3 | undefined = undefined
	private lastMoveOrderTime = 0
	private pendingWalkOutPos: Vector3 | undefined = undefined
	private pendingWalkOutTime = 0

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("PrepareUnitOrders", this.onPrepareUnitOrders.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero !== undefined
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.lastMoveTargetPos = undefined
		this.lastMoveOrderTime = 0
		this.pendingWalkOutPos = undefined
		this.pendingWalkOutTime = 0
		this.pSDK.DestroyAll()
	}

	private onPrepareUnitOrders(order: ExecuteOrder): void {
		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Track manual move orders issued for the local hero
		const isHeroIssuer = order.Issuers.length === 0 || order.Issuers.some(u => u === hero || u.Index === hero.Index)

		if (isHeroIssuer) {
			if (
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_DIRECTION
			) {
				this.lastMoveTargetPos = order.Position.Clone()
				this.lastMoveOrderTime = GameState.RawGameTime
			} else if (
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_TARGET &&
				order.Target instanceof Entity
			) {
				this.lastMoveTargetPos = order.Target.Position.Clone()
				this.lastMoveOrderTime = GameState.RawGameTime
			}
		}
	}

	private PostDataUpdate(dt: number): void {
		if (dt === 0 || !this.hasLocalHero || !this.enabled.value) {
			this.pSDK.DestroyByKey("sprout_target_tree")
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.pSDK.DestroyByKey("sprout_target_tree")
			return
		}

		// Process pending walk-out movement
		if (
			this.pendingWalkOutPos &&
			GameState.RawGameTime >= this.pendingWalkOutTime &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsChanneling
		) {
			const pos = this.pendingWalkOutPos.Clone()
			this.pendingWalkOutPos = undefined
			claimOrder()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
				issuers: [hero],
				position: pos,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
		}

		if (this.sleeper.Sleeping || hero.IsStunned || hero.IsHexed || hero.IsChanneling) {
			return
		}

		// 1. Check if hero has a usable tree-cutting tool
		const cutTool = this.getUsableCutItem(hero)
		if (!cutTool) {
			this.pSDK.DestroyByKey("sprout_target_tree")
			return
		}

		// 2. Query nearby candidate trees (<= 350 units)
		const allNearbyTrees = this.getNearbyTrees(hero, 350)
		if (allNearbyTrees.length === 0) {
			this.pSDK.DestroyByKey("sprout_target_tree")
			return
		}

		// 3. Find the best tree to cut (Sprout, Hoodwink Acorn, or Branch)
		const targetTree = this.findTargetTree(hero, allNearbyTrees, cutTool.castRange)
		if (!targetTree) {
			this.pSDK.DestroyByKey("sprout_target_tree")
			return
		}

		// 4. Visual Indicator
		if (this.drawIndicator.value) {
			this.pSDK.DrawCircle("sprout_target_tree", targetTree as Entity, 75, {
				Color: new Color(50, 255, 100, 240),
				Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
			})
		} else {
			this.pSDK.DestroyByKey("sprout_target_tree")
		}

		// 5. Execute Cut Order
		claimOrder()
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET_TREE,
			issuers: [hero],
			target: targetTree as Entity,
			ability: cutTool.item.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})

		this.sleeper.Sleep(GameState.InputLag * 1000 + 200)

		// 6. Schedule walk out in original direction
		if (this.autoWalkOut.value) {
			const walkTarget = this.getWalkOutTarget(hero, targetTree)
			if (walkTarget) {
				this.pendingWalkOutPos = walkTarget
				this.pendingWalkOutTime = GameState.RawGameTime + 0.12
			}
		}
	}

	private findTargetTree(
		hero: Hero,
		nearbyTrees: (TempTree | Tree)[],
		maxRange: number
	): TempTree | Tree | undefined {
		// 1. Sprout Enclosure Check
		if (this.cutSprout.value && this.isTrappedBySprout(hero, nearbyTrees)) {
			return this.findBestTreeToCut(hero, nearbyTrees, maxRange)
		}

		// 2. Hoodwink Acorn Shot Tree Check (Destroy Bushwhack Trap / Acorn Bounce Tree)
		if (this.cutHoodwinkAcorn.value) {
			const acornTree = this.findHoodwinkAcornTree(hero, nearbyTrees, maxRange)
			if (acornTree) {
				return acornTree
			}
		}

		// 3. Enemy Ironwood Branch Tree Check (Single TempTree within 200 units blocking path)
		if (this.cutIronwoodBranch.value) {
			const branchTree = this.findBlockingBranchTree(hero, nearbyTrees, maxRange)
			if (branchTree) {
				return branchTree
			}
		}

		return undefined
	}

	private findHoodwinkAcornTree(
		hero: Hero,
		nearbyTrees: (TempTree | Tree)[],
		maxRange: number
	): TempTree | Tree | undefined {
		const enemyHoodwink = EntityManager.GetEntitiesByClass(Hero).find(
			h => h.IsValid && h.IsEnemy(hero) && h.Name === "npc_dota_hero_hoodwink"
		)
		if (!enemyHoodwink) {
			return undefined
		}

		// Look for any TempTree within 350 units of hero (Bushwhack danger radius is 265)
		const candidateAcorns = nearbyTrees.filter(t => t.IsTempTree && hero.Distance2D(t) <= Math.min(maxRange, 350))

		if (candidateAcorns.length === 0) {
			return undefined
		}

		// Return the closest Acorn tree to hero
		return candidateAcorns.orderBy(t => hero.Distance2D(t))[0]
	}

	private findBlockingBranchTree(
		hero: Hero,
		nearbyTrees: (TempTree | Tree)[],
		maxRange: number
	): TempTree | Tree | undefined {
		const tempTrees = nearbyTrees.filter(t => t.IsTempTree && hero.Distance2D(t) <= Math.min(maxRange, 200))
		if (tempTrees.length === 0) {
			return undefined
		}

		const moveDir = this.getMovementDirection(hero)
		for (const tree of tempTrees) {
			const toTree = tree.Position.Subtract(hero.Position)
			toTree.SetZ(0)
			if (toTree.Length2D > 0 && moveDir.Dot(toTree.Normalize()) > 0.6) {
				return tree
			}
		}

		return undefined
	}

	private getUsableCutItem(hero: Hero): { item: Item; castRange: number } | undefined {
		for (const itemName of CUT_ITEMS) {
			if (!this.itemSelector.IsEnabled(itemName)) {
				continue
			}

			const item = hero.Items.find(i => i.IsValid && i.Name === itemName)
			if (
				item &&
				item.IsValid &&
				item.CanBeUsable &&
				!hero.IsMuted &&
				item.Cooldown <= 0.1 &&
				hero.Mana >= item.ManaCost
			) {
				const castRange = item.CastRange > 0 ? item.CastRange : itemName.startsWith("item_tango") ? 165 : 450
				return { item, castRange }
			}
		}
		return undefined
	}

	private getNearbyTrees(hero: Hero, searchRadius: number): (TempTree | Tree)[] {
		const tempTrees = EntityManager.GetEntitiesByClass(TempTree).filter(
			t => t.IsValid && t.IsAlive && hero.Distance2D(t) <= searchRadius
		)
		if (this.onlySproutTrees.value) {
			return tempTrees
		}
		const mapTrees = EntityManager.GetEntitiesByClass(Tree).filter(
			t => t.IsValid && t.IsAlive && hero.Distance2D(t) <= searchRadius
		)
		return [...tempTrees, ...mapTrees]
	}

	private isTrappedBySprout(hero: Hero, nearbyTrees: (TempTree | Tree)[]): boolean {
		// 1. Sprout debuffs check on hero
		const hasSproutDebuff = hero.Buffs.some(
			b =>
				b.IsValid &&
				(b.Name === "modifier_furion_sprout_blind" ||
					b.Name === "modifier_furion_sprout_tether" ||
					b.Name === "modifier_furion_sprout_healing_aura" ||
					b.Name === "modifier_furion_sprout_blind_aura" ||
					b.Name === "modifier_furion_sprout_entangle" ||
					b.Name === "modifier_furion_sprout_marker")
		)

		// 2. Count Sprout TempTrees strictly within 230 units of hero or within 200 units of CircleCenter
		const sproutTrees = nearbyTrees.filter(t => {
			if (!t.IsTempTree) {
				return false
			}
			const distToHero = hero.Distance2D(t)
			if (distToHero > 250) {
				return false
			}
			if (t instanceof TempTree && t.CircleCenter.IsValid && t.CircleCenter.Length2D > 10) {
				return hero.Distance2D(t.CircleCenter) <= 220
			}
			return distToHero <= 220
		})

		if (hasSproutDebuff && sproutTrees.length > 0) {
			return true
		}

		if (sproutTrees.length >= 3) {
			return true
		}

		// Only if user explicitly enabled cutting normal map trees AND hero is completely enclosed
		if (!this.onlySproutTrees.value && nearbyTrees.filter(t => hero.Distance2D(t) <= 180).length >= 5) {
			return true
		}

		return false
	}

	private getMovementDirection(hero: Hero): Vector3 {
		if (this.directionMode.SelectedID === 1) {
			// Mouse Cursor Direction
			const mouse = InputManager.CursorOnWorld.Subtract(hero.Position)
			mouse.SetZ(0)
			return mouse.Length2D > 10 ? mouse.Normalize() : hero.Forward.Clone().SetZ(0).Normalize()
		}

		if (this.directionMode.SelectedID === 2) {
			// Closest Tree (no direction vector needed)
			return new Vector3()
		}

		// 0: Hero Movement Direction (Default)
		if (this.lastMoveTargetPos && GameState.RawGameTime - this.lastMoveOrderTime < 3.0) {
			const moveVec = this.lastMoveTargetPos.Subtract(hero.Position)
			moveVec.SetZ(0)
			if (moveVec.Length2D > 10) {
				return moveVec.Normalize()
			}
		}

		if (hero.Forward.Length2D > 0.01) {
			const fwd = hero.Forward.Clone()
			fwd.SetZ(0)
			return fwd.Normalize()
		}

		const cursorVec = InputManager.CursorOnWorld.Subtract(hero.Position)
		cursorVec.SetZ(0)
		return cursorVec.Length2D > 10 ? cursorVec.Normalize() : new Vector3(1, 0, 0)
	}

	private findBestTreeToCut(hero: Hero, trees: (TempTree | Tree)[], maxRange: number): TempTree | Tree | undefined {
		// Only consider trees that are within Sprout distance (<= 230 units)
		const candidateTrees = trees.filter(t => hero.Distance2D(t) <= Math.min(maxRange, 230))
		if (candidateTrees.length === 0) {
			return undefined
		}

		if (this.directionMode.SelectedID === 2) {
			// Closest tree to hero
			return candidateTrees.orderBy(t => hero.Distance2D(t))[0]
		}

		const moveDir = this.getMovementDirection(hero)
		let bestTree: TempTree | Tree | undefined
		let highestScore = -Infinity

		for (const tree of candidateTrees) {
			const toTree = tree.Position.Subtract(hero.Position)
			toTree.SetZ(0)
			const dist = toTree.Length2D
			if (dist < 1) {
				continue
			}
			const normToTree = toTree.Normalize()

			// Dot product alignment: 1.0 is directly forward, -1.0 is behind
			const dot = moveDir.Dot(normToTree)

			// TempTrees (Sprout) get bonus over static map trees
			const tempBonus = tree.IsTempTree ? 0.5 : 0

			// Score calculation: Direction alignment dominates (scale * 1000) minus distance penalty
			const score = (dot + tempBonus) * 1000 - dist

			if (score > highestScore) {
				highestScore = score
				bestTree = tree
			}
		}

		return bestTree
	}

	private getWalkOutTarget(hero: Hero, cutTree: TempTree | Tree): Vector3 | undefined {
		if (this.lastMoveTargetPos && GameState.RawGameTime - this.lastMoveOrderTime < 3.0) {
			return this.lastMoveTargetPos
		}

		// Walk through where the tree was
		const exitDir = cutTree.Position.Subtract(hero.Position)
		exitDir.SetZ(0)
		if (exitDir.Length2D > 10) {
			return hero.Position.Add(exitDir.Normalize().MultiplyScalar(350))
		}

		return InputManager.CursorOnWorld
	}
})()
