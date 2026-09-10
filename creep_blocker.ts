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
	 * mathematically clamping the turning angle to at most maxAngleDeg (tight cone <= 15°).
	 * This guarantees the hero never veers into the side of the lane, never turns backwards,
	 * and eliminates turn-rate deceleration completely.
	 */
	private getForwardConeTarget(
		heroPos: Vector3,
		laneDir: Vector3,
		lanePerp: Vector3,
		desiredFwd: number,
		desiredLat: number,
		maxAngleDeg = 14
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
			: this.smoothedLaneDir.MultiplyScalar(0.85).Add(rawLaneDir.MultiplyScalar(0.15)).Normalize()

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
		// CASE 1: HERO IS LEGITIMATELY BEHIND THE WAVE (forwardDist <= 0)
		// =========================================================================
		// The creeps have passed the hero completely. Sprint straight forward down the lane.
		// No 30° sideways veering! Run straight down the lane corridor.
		if (forwardDist <= 0) {
			this.lastActionWasStop = false
			const catchUpTarget = centroid.Add(laneDir.MultiplyScalar(50))
			this.targetBlockPos = catchUpTarget.Clone()
			hero.MoveTo(catchUpTarget, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
			return
		}

		// =========================================================================
		// CASE 2: HERO IN PHYSICAL CONTACT / BEING PUSHED (0 < forwardDist < 34)
		// =========================================================================
		// Hero is right in front of creeps and being bumped/pushed.
		// DO NOT STOP! And DO NOT VEER SIDEWAYS!
		// Take a micro-step STRAIGHT FORWARD down the lane (angle <= 10°) to re-establish the buffer.
		if (forwardDist < 34) {
			this.lastActionWasStop = false
			const centerPull = -lateralDist * 0.5
			const surgeTarget = this.getForwardConeTarget(hero.Position, laneDir, lanePerp, 30, centerPull, 10)
			this.targetBlockPos = surgeTarget.Clone()
			hero.MoveTo(surgeTarget, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// =========================================================================
		// CASE 3: HERO IS TOO FAR AHEAD (forwardDist > 58)
		// =========================================================================
		// Hero opened up a gap.
		// If off-center (> 10 units), take a tiny step towards center (angle <= 12°).
		if (forwardDist > 58) {
			if (Math.abs(lateralDist) > 10) {
				this.lastActionWasStop = false
				const alignTarget = this.getForwardConeTarget(
					hero.Position,
					laneDir,
					lanePerp,
					20,
					-lateralDist * 0.5,
					12
				)
				this.targetBlockPos = alignTarget.Clone()
				hero.MoveTo(alignTarget, false, false)
				this.sleeper.Sleep(GameState.InputLag * 1000 + 45)
				return
			}

			// In line with creeps: STOP and wait for them to run into our back
			this.lastActionWasStop = true
			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 65)
			return
		}

		// =========================================================================
		// CASE 4: ACTIVE PRO ZIGZAG & S-STOP BODY BLOCK ZONE (34 <= forwardDist <= 58)
		// =========================================================================
		// 4A. Slip Detection: Check if any front creep is sneaking around our flank
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

		// If a creep is slipping around a side, step forward-diagonally with angle <= 16° to cut it off
		if (slippingCreepOffset !== 0) {
			this.lastActionWasStop = false
			const cutOffTarget = this.getForwardConeTarget(
				hero.Position,
				laneDir,
				lanePerp,
				28,
				slippingCreepOffset - lateralDist,
				16
			)
			this.targetBlockPos = cutOffTarget.Clone()
			hero.MoveTo(cutOffTarget, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 45)
			return
		}

		// 4B. Pro Zigzag & S-Stop Rhythm:
		// Alternate between:
		// 1) OrderStop (S-tap) -> creeps bump into hero's back and stutter-step
		// 2) Micro-step forward-zigzag (angle <= 14°) -> subtle 8-unit lateral weave in lane center
		if (this.lastActionWasStop) {
			// Previous action was STOP -> take a micro-step forward & zigzag
			this.lastActionWasStop = false
			this.zigzagSide = -this.zigzagSide // Flip lateral side: left <-> right

			// Tight lateral wiggle (8 units) with center pull
			const centerPull = -lateralDist * 0.4
			const desiredLat = this.zigzagSide * 8 + centerPull

			// Strictly clamped <= 14° forward cone (total swing <= 28° << 90°)
			const stepTarget = this.getForwardConeTarget(hero.Position, laneDir, lanePerp, 28, desiredLat, 14)

			this.targetBlockPos = stepTarget.Clone()
			hero.MoveTo(stepTarget, false, false)

			// Micro-step sleep duration based on hero move speed
			const stepMs = Math.round(Math.max(40, Math.min(65, (18 / Math.max(heroSpeed, 250)) * 1000)))
			this.sleeper.Sleep(GameState.InputLag * 1000 + stepMs)
		} else {
			// Previous action was MOVE -> tap S (OrderStop) to halt and block
			this.lastActionWasStop = true

			// Dynamic stop duration: allows creep to bump solidly into hero's rear hull
			const timeToImpactMs = Math.max(0, ((forwardDist - contactThreshold) / creepSpeed) * 1000)
			const dynamicStopMs = Math.round(Math.max(50, Math.min(75, 40 + timeToImpactMs * 0.35)))

			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + dynamicStopMs)
		}
	}
})()
