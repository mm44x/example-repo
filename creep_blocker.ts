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
		"Hold to continuously body block the oncoming allied creep wave using pro stop & go"
	)

	private readonly searchRadius = this.node.AddSlider(
		"Search Radius",
		900,
		500,
		1500,
		50,
		"Radius to search for allied lane creeps around your hero"
	)

	private readonly stopOnEnemy = this.node.AddToggle(
		"Stop When Enemy Nearby",
		true,
		"Temporarily releases block if enemy heroes (< 900) or enemy lane creeps (< 800) are nearby"
	)

	private readonly drawVisuals = this.node.AddToggle(
		"Draw Visual Indicators",
		true,
		"Visualizes the locked target creep and target intercept position on screen"
	)

	private readonly sleeper = new TickSleeper()

	// State tracking
	private lockedCreep: Creep | undefined = undefined
	private targetBlockPos: Vector3 | undefined = undefined
	private isCurrentlyBlocking = false
	private isStopped = false
	private zigzagSide = 1 // 1 for right, -1 for left
	private smoothedLaneDir: Vector3 | undefined = undefined

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
		this.lockedCreep = undefined
		this.targetBlockPos = undefined
		this.isStopped = false
		this.zigzagSide = 1
		this.smoothedLaneDir = undefined
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

		// Render the Locked Target Creep (Green)
		if (this.lockedCreep && this.lockedCreep.IsValid && this.lockedCreep.IsAlive) {
			const creepScreen = RendererSDK.WorldToScreen(this.lockedCreep.Position)
			if (creepScreen) {
				RendererSDK.OutlinedCircle(creepScreen, new Vector2(28, 28), Color.Green, 2)
			}
		}

		// Render the Intercept / Target Block Position (Aqua)
		if (this.targetBlockPos) {
			const targetScreen = RendererSDK.WorldToScreen(this.targetBlockPos)
			if (targetScreen) {
				RendererSDK.OutlinedCircle(targetScreen, new Vector2(16, 16), Color.Aqua, 2)
				if (this.lockedCreep && this.lockedCreep.IsValid && this.lockedCreep.IsAlive) {
					const creepScreen = RendererSDK.WorldToScreen(this.lockedCreep.Position)
					if (creepScreen) {
						RendererSDK.Line(creepScreen, targetScreen, Color.Aqua.SetA(180), 2)
					}
				}
			}
		}
	}

	/**
	 * Mathematically guarantees that any movement vector from hero.Position
	 * ALWAYS has a positive forward component along the lane direction,
	 * with the lateral turning angle strictly clamped to maxAngleDeg (default 24°).
	 * This makes it impossible for the hero to face backwards or turn > 90°.
	 */
	private getForwardTarget(
		heroPos: Vector3,
		laneDir: Vector3,
		lanePerp: Vector3,
		stepFwd: number,
		desiredLat: number,
		maxAngleDeg = 24
	): Vector3 {
		const fwd = Math.max(stepFwd, 20)
		const maxLat = fwd * Math.tan((maxAngleDeg * Math.PI) / 180)
		const lat = Math.max(-maxLat, Math.min(maxLat, desiredLat))
		return heroPos.Add(laneDir.MultiplyScalar(fwd)).Add(lanePerp.MultiplyScalar(lat))
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

		// 1. Check for nearby enemies (prevent suicidal blocking into enemy heroes / creeps)
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

		// 3. Determine Lane Marching Direction (waveDir)
		let sumX = 0
		let sumY = 0
		let movingCreepCount = 0
		for (const c of allyCreeps) {
			if (c.Forward.Length2D > 0.05) {
				sumX += c.Forward.x
				sumY += c.Forward.y
				movingCreepCount++
			}
		}

		let rawLaneDir: Vector3
		if (movingCreepCount > 0) {
			rawLaneDir = new Vector3(sumX, sumY, 0).Normalize()
		} else if (hero.Forward.Length2D > 0.1) {
			rawLaneDir = hero.Forward.Clone().SetZ(0).Normalize()
		} else {
			rawLaneDir = new Vector3(1, 0, 0)
		}

		// Smooth lane direction to eliminate direction flutter
		this.smoothedLaneDir = !this.smoothedLaneDir
			? rawLaneDir.Clone()
			: this.smoothedLaneDir.MultiplyScalar(0.85).Add(rawLaneDir.MultiplyScalar(0.15)).Normalize()

		const laneDir = this.smoothedLaneDir
		const lanePerp = new Vector3(-laneDir.y, laneDir.x, 0)

		// 4. Select Target Creep with Hysteresis (Prevents target-switching flutter!)
		let bestCreep: Creep | undefined
		let maxProgress = -Infinity

		for (const c of allyCreeps) {
			const prog = c.Position.x * laneDir.x + c.Position.y * laneDir.y
			if (prog > maxProgress) {
				maxProgress = prog
				bestCreep = c
			}
		}

		if (!bestCreep) {
			this.resetBlockState()
			return
		}

		// Hysteresis: Keep locked onto current creep if it is still within 30 units of the leader
		if (
			this.lockedCreep &&
			this.lockedCreep.IsValid &&
			this.lockedCreep.IsAlive &&
			!this.lockedCreep.IsWaitingToSpawn &&
			this.lockedCreep.Distance2D(hero) <= this.searchRadius.value
		) {
			const lockedProg = this.lockedCreep.Position.x * laneDir.x + this.lockedCreep.Position.y * laneDir.y
			if (maxProgress - lockedProg <= 30) {
				bestCreep = this.lockedCreep
			}
		}

		this.lockedCreep = bestCreep

		// 5. Geometry relative to target lead creep
		const toHero = hero.Position.Subtract(bestCreep.Position)
		toHero.SetZ(0)

		const fwdDist = toHero.x * laneDir.x + toHero.y * laneDir.y
		const latDist = toHero.x * lanePerp.x + toHero.y * lanePerp.y

		claimOrder()
		setCreepBlockingActive(true)
		this.isCurrentlyBlocking = true

		// =========================================================================
		// SCENARIO 1: OVERTAKE (Hero is behind or pressing into creep's rear hull)
		// fwdDist < 35: Hero CANNOT walk through the creep's back!
		// Move FORWARD along the lane while shifting laterally to clear the creep hull!
		// =========================================================================
		if (fwdDist < 35) {
			this.isStopped = false
			// Desired flank is 38 units to the open side (relative to creep)
			const flankSide = latDist >= 0 ? 1 : -1
			const desiredLatOffset = flankSide * 38 - latDist
			const overtakePos = this.getForwardTarget(hero.Position, laneDir, lanePerp, 45, desiredLatOffset, 25)

			this.targetBlockPos = overtakePos.Clone()
			hero.MoveTo(overtakePos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 70)
			return
		}

		// =========================================================================
		// SCENARIO 2: CUTTING IN (Hero is ahead, but laterally off the creep's path)
		// fwdDist >= 35, but |latDist| > 16:
		// Step FORWARD and INWARD into the creep's path! NEVER step backwards!
		// =========================================================================
		if (Math.abs(latDist) > 16) {
			this.isStopped = false
			const inwardPull = -latDist * 0.7
			const cutInPos = this.getForwardTarget(hero.Position, laneDir, lanePerp, 28, inwardPull, 24)

			this.targetBlockPos = cutInPos.Clone()
			hero.MoveTo(cutInPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 65)
			return
		}

		// =========================================================================
		// SCENARIO 3: HERO IS TOO FAR AHEAD (fwdDist > 65 and |latDist| <= 16)
		// Hero is ahead on the creep's line of march.
		// Stand still in the creep's path and wait for the creep to bump us!
		// =========================================================================
		if (fwdDist > 65) {
			this.isStopped = true
			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 90)
			return
		}

		// =========================================================================
		// SCENARIO 4: ACTIVE BODY BLOCKING (35 <= fwdDist <= 65 and |latDist| <= 16)
		// Hero is squarely in front of the lead creep!
		// Authentic human cadence: Stop (120ms) -> Micro-step (100ms)
		// =========================================================================
		if (this.isStopped) {
			// Hero was stopped, creep has bumped into hero's back!
			// Take a micro-step forward down the lane with subtle lateral weave (6 units)
			this.isStopped = false
			this.zigzagSide = -this.zigzagSide

			const lateralWeave = this.zigzagSide * 6 - latDist * 0.3
			const stepPos = this.getForwardTarget(hero.Position, laneDir, lanePerp, 24, lateralWeave, 15)

			this.targetBlockPos = stepPos.Clone()
			hero.MoveTo(stepPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
		} else {
			// Hero was moving, now tap S (OrderStop) to halt and let creep bump!
			this.isStopped = true
			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 120)
		}
	}
})()
