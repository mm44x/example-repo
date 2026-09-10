import {
	Color,
	Creep,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	LocalPlayer,
	Menu,
	RendererSDK,
	TickSleeper,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder, setCreepBlockingActive } from "./coordination"

new (class CreepLaneBlocker {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode(
		"Creep Blocker",
		"panorama/images/heroes/icons/npc_dota_hero_chen_png.vtex_c"
	)

	private readonly enabled = this.node.AddToggle(
		"Enable Creep Blocker",
		true,
		"Automatically body blocks allied lane creeps to delay their arrival at the lane clash"
	)

	private readonly blockKey = this.node.AddKeybind(
		"Creep Block Key",
		"Space",
		"Hold to continuously body block the nearest allied creep wave"
	)

	private readonly searchRadius = this.node.AddSlider(
		"Search Radius",
		800,
		400,
		1400,
		50,
		"Radius to search for allied lane creeps around your hero"
	)

	private readonly blockDistance = this.node.AddSlider(
		"Block Distance",
		45,
		30,
		75,
		5,
		"Target lead distance ahead of the front creep (Hero collision is ~24, creep is ~16)"
	)

	private readonly stopDuration = this.node.AddSlider(
		"Micro-Stop Duration (ms)",
		90,
		50,
		180,
		10,
		"Duration to hold position when creep makes physical contact before stepping forward again"
	)

	private readonly stopOnEnemy = this.node.AddToggle(
		"Stop When Enemy Nearby",
		true,
		"Temporarily releases block if enemy heroes (< 900) or enemy lane creeps (< 800) are nearby"
	)

	private readonly drawVisuals = this.node.AddToggle(
		"Draw Visual Indicators",
		true,
		"Highlights the lead creep with a green ring and displays the intercept point on screen"
	)

	private readonly sleeper = new TickSleeper()

	private leadCreep: Creep | undefined = undefined
	private targetBlockPos: Vector3 | undefined = undefined
	private isCurrentlyBlocking = false

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.OnDraw.bind(this))
		EventsSDK.on("PrepareUnitOrders", this.onPrepareUnitOrders.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
		EventsSDK.on("GameStarted", this.onGameEnded.bind(this))
	}

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero !== undefined
	}

	private onGameEnded(): void {
		this.sleeper.ResetTimer()
		this.resetBlockState()
	}

	private resetBlockState(): void {
		if (this.isCurrentlyBlocking) {
			this.isCurrentlyBlocking = false
			setCreepBlockingActive(false)
		}
		this.leadCreep = undefined
		this.targetBlockPos = undefined
	}

	private onPrepareUnitOrders(order: ExecuteOrder): false | void {
		if (!this.hasLocalHero || !this.enabled.value) {
			return
		}

		// Block accidental attack orders while holding the creep block key
		// @ts-ignore
		if (this.blockKey.isPressed) {
			if (
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_MOVE
			) {
				return false
			}
		}
	}

	private OnDraw(): void {
		if (!this.hasLocalHero || !this.enabled.value || !this.drawVisuals.value) {
			return
		}

		// @ts-ignore
		if (!this.blockKey.isPressed) {
			return
		}

		if (this.leadCreep && this.leadCreep.IsValid && this.leadCreep.IsAlive) {
			const creepScreen = RendererSDK.WorldToScreen(this.leadCreep.Position)
			if (creepScreen) {
				RendererSDK.OutlinedCircle(creepScreen, new Vector2(28, 28), Color.Green, 2)
			}
		}

		if (this.targetBlockPos) {
			const blockScreen = RendererSDK.WorldToScreen(this.targetBlockPos)
			if (blockScreen) {
				RendererSDK.OutlinedCircle(blockScreen, new Vector2(16, 16), Color.Aqua, 2)
				if (this.leadCreep && this.leadCreep.IsValid) {
					const creepScreen = RendererSDK.WorldToScreen(this.leadCreep.Position)
					if (creepScreen) {
						RendererSDK.Line(creepScreen, blockScreen, Color.Aqua.SetA(180), 2)
					}
				}
			}
		}
	}

	private PostDataUpdate(dt: number): void {
		if (dt === 0 || !this.hasLocalHero || !this.enabled.value || ExecuteOrder.DisableHumanizer) {
			this.resetBlockState()
			return
		}

		// @ts-ignore
		if (!this.blockKey.isPressed) {
			this.resetBlockState()
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive || hero.IsStunned || hero.IsHexed || hero.IsChanneling) {
			this.resetBlockState()
			return
		}

		if (this.sleeper.lastSleepTickCount > (GameState.RawGameTime + 60) * 1000) {
			this.sleeper.ResetTimer()
		}

		if (this.sleeper.Sleeping) {
			return
		}

		// 1. Check for nearby enemies (to prevent suicidal blocking into enemy heroes / creeps)
		if (this.stopOnEnemy.value) {
			const enemyHeroNearby = EntityManager.GetEntitiesByClass(Hero).some(
				h => h.IsValid && h.IsAlive && h.IsEnemy(hero) && !h.IsIllusion && h.Distance2D(hero) <= 900
			)
			if (enemyHeroNearby) {
				this.resetBlockState()
				return
			}

			const enemyCreepNearby = EntityManager.GetEntitiesByClass(Creep).some(
				c => c.IsValid && c.IsAlive && c.IsEnemy(hero) && c.IsLaneCreep && c.Distance2D(hero) <= 800
			)
			if (enemyCreepNearby) {
				this.resetBlockState()
				return
			}
		}

		// 2. Query nearby allied lane creeps
		const allyCreeps = EntityManager.GetEntitiesByClass(Creep).filter(
			c =>
				c.IsValid &&
				c.IsAlive &&
				c.IsLaneCreep &&
				!c.IsEnemy(hero) &&
				!c.IsNeutral &&
				!c.IsWaitingToSpawn &&
				c.Distance2D(hero) <= this.searchRadius.value
		)

		if (allyCreeps.length === 0) {
			this.resetBlockState()
			return
		}

		// 3. Compute the marching direction of the creep wave
		let sumX = 0
		let sumY = 0
		for (const c of allyCreeps) {
			if (c.Forward.Length2D > 0.05) {
				sumX += c.Forward.x
				sumY += c.Forward.y
			}
		}

		let waveDir = new Vector3(sumX, sumY, 0)
		if (waveDir.Length2D > 0.1) {
			waveDir = waveDir.Normalize()
		} else if (hero.Forward.Length2D > 0.1) {
			waveDir = hero.Forward.Clone().SetZ(0).Normalize()
		} else {
			waveDir = new Vector3(1, 0, 0)
		}

		// 4. Identify the Lead Creep (the one furthest ahead along the wave's marching vector)
		let bestLeadCreep: Creep | undefined
		let maxProgress = -Infinity

		for (const c of allyCreeps) {
			const progress = c.Position.x * waveDir.x + c.Position.y * waveDir.y
			if (progress > maxProgress) {
				maxProgress = progress
				bestLeadCreep = c
			}
		}

		if (!bestLeadCreep || !bestLeadCreep.IsValid) {
			this.resetBlockState()
			return
		}

		this.leadCreep = bestLeadCreep

		// 5. Geometry & Relative Decomposition
		let creepDir = bestLeadCreep.Forward.Clone()
		creepDir.SetZ(0)
		creepDir = creepDir.Length2D > 0.1 ? creepDir.Normalize() : waveDir

		const perp = new Vector3(-creepDir.y, creepDir.x, 0)
		const toHero = hero.Position.Subtract(bestLeadCreep.Position)
		toHero.SetZ(0)

		const forwardDist = toHero.x * creepDir.x + toHero.y * creepDir.y
		const lateralDist = toHero.x * perp.x + toHero.y * perp.y

		const desiredDist = this.blockDistance.value
		const idealBlockPos = bestLeadCreep.Position.Add(creepDir.MultiplyScalar(desiredDist))
		this.targetBlockPos = idealBlockPos.Clone()

		// 6. Action Execution
		claimOrder()
		setCreepBlockingActive(true)
		this.isCurrentlyBlocking = true

		// STATE A: Hero is behind the lead creep or alongside its flank (forwardDist < 25)
		// Sprint ahead to cut in front of the creep
		if (forwardDist < 25) {
			hero.MoveTo(idealBlockPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 70)
			return
		}

		// STATE B: Hero is running too far ahead (forwardDist > desiredDist + 35)
		// Hold position so the creep catches up and hits hero's back
		if (forwardDist > desiredDist + 35) {
			hero.HoldPosition(hero.Position, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + this.stopDuration.value)
			return
		}

		// STATE C: Hero is in the active collision zone (25 <= forwardDist <= desiredDist + 35)
		// Check lateral alignment: If creep is veering/sliding off-center, steer immediately to block
		if (Math.abs(lateralDist) > 16) {
			hero.MoveTo(idealBlockPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
			return
		}

		// Creep is dead-center behind the hero!
		// If creep is already in hull-to-hull contact (forwardDist <= 42):
		// Take a micro-step forward to maintain distance and prevent slipping
		if (forwardDist <= 42) {
			hero.MoveTo(idealBlockPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
			return
		}

		// Creep is close and about to hit hero hull: HOLD POSITION to form a solid brick wall!
		hero.HoldPosition(hero.Position, false, false)
		this.sleeper.Sleep(GameState.InputLag * 1000 + this.stopDuration.value)
	}
})()
