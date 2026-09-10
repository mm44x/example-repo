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
		"Hold to continuously body block the oncoming allied creep wave using pro zigzag S-stop"
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
		"Visualizes the wave frontline center, target zigzag position, and collision corridor"
	)

	private readonly sleeper = new TickSleeper()

	// State tracking
	private frontlineCenter: Vector3 | undefined = undefined
	private targetBlockPos: Vector3 | undefined = undefined
	private isCurrentlyBlocking = false
	private lastActionWasStop = false
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
		this.frontlineCenter = undefined
		this.targetBlockPos = undefined
		this.lastActionWasStop = false
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

		// Render the Wave Frontline Centroid (Green)
		if (this.frontlineCenter) {
			const frontScreen = RendererSDK.WorldToScreen(this.frontlineCenter)
			if (frontScreen) {
				RendererSDK.OutlinedCircle(frontScreen, new Vector2(24, 24), Color.Green, 2)
			}
		}

		// Render the Intercept / Zigzag Target Point (Aqua)
		if (this.targetBlockPos) {
			const targetScreen = RendererSDK.WorldToScreen(this.targetBlockPos)
			if (targetScreen) {
				RendererSDK.OutlinedCircle(targetScreen, new Vector2(16, 16), Color.Aqua, 2)
				if (this.frontlineCenter) {
					const frontScreen = RendererSDK.WorldToScreen(this.frontlineCenter)
					if (frontScreen) {
						RendererSDK.Line(frontScreen, targetScreen, Color.Aqua.SetA(180), 2)
					}
				}
			}
		}
	}

	/**
	 * Computes a destination that is strictly in front of the hero along the lane direction,
	 * mathematically clamping the turning angle to at most maxAngleDeg (default 30°).
	 * This prevents the hero from ever turning backwards or rotating > 90°, eliminating turn-rate delay.
	 */
	private getForwardConeTarget(
		heroPos: Vector3,
		laneDir: Vector3,
		lanePerp: Vector3,
		desiredFwd: number,
		desiredLat: number,
		maxAngleDeg = 30
	): Vector3 {
		// Forward step must strictly be positive down the lane
		const fwd = Math.max(desiredFwd, 20)
		// Max lateral offset allowed by maxAngleDeg
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

		// Exponential smoothing to prevent direction twitching
		this.smoothedLaneDir = !this.smoothedLaneDir
			? rawLaneDir.Clone()
			: this.smoothedLaneDir.MultiplyScalar(0.8).Add(rawLaneDir.MultiplyScalar(0.2)).Normalize()

		const laneDir = this.smoothedLaneDir
		const lanePerp = new Vector3(-laneDir.y, laneDir.x, 0)

		// 4. Calculate Wave Frontline Centroid (ELIMINATES TARGET SWITCHING JITTER)
		let maxProgress = -Infinity
		for (const c of allyCreeps) {
			const prog = c.Position.x * laneDir.x + c.Position.y * laneDir.y
			if (prog > maxProgress) {
				maxProgress = prog
			}
		}

		// Frontline creeps: all creeps within 80 units of the lead position (typically 2-3 melee creeps)
		const frontlineCreeps: Creep[] = []
		let sumPosX = 0
		let sumPosY = 0
		let sumPosZ = 0

		for (const c of allyCreeps) {
			const prog = c.Position.x * laneDir.x + c.Position.y * laneDir.y
			if (prog >= maxProgress - 80) {
				frontlineCreeps.push(c)
				sumPosX += c.Position.x
				sumPosY += c.Position.y
				sumPosZ += c.Position.z
			}
		}

		if (frontlineCreeps.length === 0) {
			this.resetBlockState()
			return
		}

		const frontlineCount = frontlineCreeps.length
		const centroid = new Vector3(sumPosX / frontlineCount, sumPosY / frontlineCount, sumPosZ / frontlineCount)
		this.frontlineCenter = centroid.Clone()

		// 5. Relative Geometry: Hero relative to Frontline Centroid
		const toHero = hero.Position.Subtract(centroid)
		toHero.SetZ(0)

		const forwardDist = toHero.x * laneDir.x + toHero.y * laneDir.y
		const lateralDist = toHero.x * lanePerp.x + toHero.y * lanePerp.y

		// 6. Automatic Physics Parameters
		const heroHull = hero.HullRadius > 0 ? hero.HullRadius : 24
		const creepHull = 16
		const contactThreshold = heroHull + creepHull // ~40 units

		const heroSpeed = hero.MoveSpeed
		const creepSpeed = Math.max(frontlineCreeps[0]?.MoveSpeed || 325, 200)

		claimOrder()
		setCreepBlockingActive(true)
		this.isCurrentlyBlocking = true

		// =========================================================================
		// CASE 1: HERO IS BEHIND / BEING OVERTAKEN (forwardDist < 36)
		// =========================================================================
		// Hero is being pushed or fell behind the front creeps.
		// NEVER call Stop here! We must accelerate forward down the lane.
		if (forwardDist < 36) {
			this.lastActionWasStop = false

			// If deeply behind the wave, flank slightly to sprint past without hull drag
			if (forwardDist < 15) {
				const flankSide = lateralDist >= 0 ? 1 : -1
				const flankTarget = this.getForwardConeTarget(hero.Position, laneDir, lanePerp, 55, flankSide * 28, 28)
				this.targetBlockPos = flankTarget.Clone()
				hero.MoveTo(flankTarget, false, false)
				this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
				return
			}

			// In contact/pushing: surge forward down the lane to regain the buffer
			const surgeTarget = this.getForwardConeTarget(hero.Position, laneDir, lanePerp, 45, -lateralDist * 0.3, 20)
			this.targetBlockPos = surgeTarget.Clone()
			hero.MoveTo(surgeTarget, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 55)
			return
		}

		// =========================================================================
		// CASE 2: HERO IS TOO FAR AHEAD (forwardDist > 65)
		// =========================================================================
		// Hero is outrunning the creeps. Stop and wait for them to bump our back.
		if (forwardDist > 65) {
			// If laterally off-center (> 14 units), step diagonally onto the centerline while moving forward
			if (Math.abs(lateralDist) > 14) {
				this.lastActionWasStop = false
				const alignTarget = this.getForwardConeTarget(
					hero.Position,
					laneDir,
					lanePerp,
					25,
					-lateralDist * 0.5,
					24
				)
				this.targetBlockPos = alignTarget.Clone()
				hero.MoveTo(alignTarget, false, false)
				this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
				return
			}

			// Directly in their line of march: STOP and let them run into our back
			this.lastActionWasStop = true
			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 70)
			return
		}

		// =========================================================================
		// CASE 3: ACTIVE PRO ZIGZAG & S-STOP BODY BLOCK ZONE (36 <= forwardDist <= 65)
		// =========================================================================
		// 3A. Slip Detection: Check if any front creep is sneaking around our flank
		let slippingCreepOffset = 0
		for (const c of frontlineCreeps) {
			const cToCentroid = c.Position.Subtract(centroid)
			const cFwd = cToCentroid.x * laneDir.x + cToCentroid.y * laneDir.y
			const cLat = cToCentroid.x * lanePerp.x + cToCentroid.y * lanePerp.y

			// Creep is at the frontline
			if (cFwd >= -20) {
				const creepDistToHeroFwd = forwardDist - cFwd
				if (creepDistToHeroFwd < contactThreshold + 8) {
					const lateralGap = cLat - lateralDist
					if (Math.abs(lateralGap) > 13) {
						slippingCreepOffset = cLat
						break
					}
				}
			}
		}

		// If a creep is slipping around a side, step forward-diagonally to cut it off (shut the door)
		if (slippingCreepOffset !== 0) {
			this.lastActionWasStop = false
			const cutOffTarget = this.getForwardConeTarget(
				hero.Position,
				laneDir,
				lanePerp,
				35,
				slippingCreepOffset - lateralDist,
				30
			)
			this.targetBlockPos = cutOffTarget.Clone()
			hero.MoveTo(cutOffTarget, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// 3B. Pro Zigzag & S-Stop Rhythm:
		// Alternate between:
		// 1) OrderStop (S-tap) -> creeps bump into hero's back and stutter-step
		// 2) Micro-step forward-zigzag (<= 30° cone) -> sweeps a wall across the wave
		if (this.lastActionWasStop) {
			// Previous action was STOP -> take a micro-step forward & zigzag
			this.lastActionWasStop = false
			this.zigzagSide = -this.zigzagSide // Flip lateral side: left <-> right

			// Desired lateral offset: zigzag offset + slight pull towards lane center
			const centerPull = -lateralDist * 0.35
			const desiredLat = this.zigzagSide * 16 + centerPull

			// Forward-cone target: angle mathematically clamped <= 28° (total swing <= 56° << 90°)
			const stepTarget = this.getForwardConeTarget(hero.Position, laneDir, lanePerp, 35, desiredLat, 28)

			this.targetBlockPos = stepTarget.Clone()
			hero.MoveTo(stepTarget, false, false)

			// Micro-step sleep duration based on hero move speed
			const stepMs = Math.round(Math.max(45, Math.min(70, (20 / Math.max(heroSpeed, 250)) * 1000)))
			this.sleeper.Sleep(GameState.InputLag * 1000 + stepMs)
		} else {
			// Previous action was MOVE -> tap S (OrderStop) to halt and block
			this.lastActionWasStop = true

			// Dynamic stop duration: allows creep to bump solidly into hero's rear hull
			const timeToImpactMs = Math.max(0, ((forwardDist - contactThreshold) / creepSpeed) * 1000)
			const dynamicStopMs = Math.round(Math.max(50, Math.min(80, 45 + timeToImpactMs * 0.4)))

			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + dynamicStopMs)
		}
	}
})()
