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

		let laneDir: Vector3
		if (movingCreepCount > 0) {
			laneDir = new Vector3(sumX, sumY, 0).Normalize()
		} else if (hero.Forward.Length2D > 0.1) {
			laneDir = hero.Forward.Clone().SetZ(0).Normalize()
		} else {
			laneDir = new Vector3(1, 0, 0)
		}

		// Lane Perpendicular Vector (Lateral Axis crosswise to the lane)
		const lanePerp = new Vector3(-laneDir.y, laneDir.x, 0)

		// 4. Calculate Wave Frontline Centroid (ELIMINATES TARGET SWITCHING JITTER)
		// We project all creep positions onto laneDir to find their progression along the lane.
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
		const speedDelta = heroSpeed - creepSpeed

		// Auto block buffer distance:
		// If hero is faster, maintain ~44-48 units to absorb collision smoothly.
		// If hero is slower, hug as close as ~42 units to prevent creeps slipping by.
		const autoBlockDist = contactThreshold + Math.max(2, Math.min(10, 3 + speedDelta * 0.08))

		claimOrder()
		setCreepBlockingActive(true)
		this.isCurrentlyBlocking = true

		// =========================================================================
		// CASE 1: HERO IS BEHIND THE FRONTLINE (forwardDist < autoBlockDist - 6)
		// =========================================================================
		// The hero is behind or physically entangled with the creeps.
		// NEVER call Stop here!
		// Flank laterally to avoid pathfinding collision against the creeps' hulls.
		if (forwardDist < autoBlockDist - 6) {
			this.lastActionWasStop = false
			const flankSide = lateralDist >= 0 ? 1 : -1
			const flankOffset = lanePerp.MultiplyScalar(flankSide * Math.max(50, creepHull + heroHull + 15))
			const overtakePos = centroid.Add(laneDir.MultiplyScalar(autoBlockDist + 35)).Add(flankOffset)

			this.targetBlockPos = overtakePos.Clone()
			hero.MoveTo(overtakePos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
			return
		}

		// =========================================================================
		// CASE 2: HERO IS FAR AHEAD / POSITIONING EARLY (forwardDist > autoBlockDist + 30)
		// =========================================================================
		// "Position early: Wait near the spawner or high ground stairs before the creeps appear.
		// Stand in their path: Walk directly into the path of the oncoming creeps so they bump into your hero model."
		if (forwardDist > autoBlockDist + 30) {
			const interceptDist = Math.min(forwardDist, autoBlockDist + 25)
			const centerlinePos = centroid.Add(laneDir.MultiplyScalar(interceptDist))
			this.targetBlockPos = centerlinePos.Clone()

			// If hero is laterally off the wave's marching corridor (> 14 units), step onto the centerline
			if (Math.abs(lateralDist) > 14) {
				this.lastActionWasStop = false
				hero.MoveTo(centerlinePos, false, false)
				this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
				return
			}

			// Already directly in their line of march: STOP and stand in their path!
			this.lastActionWasStop = true
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 70)
			return
		}

		// =========================================================================
		// CASE 3: ACTIVE ZIGZAG & S-STOP BODY BLOCK ZONE
		// =========================================================================
		// 3A. Slip Detection: Check if any individual front creep is slipping past on a flank!
		let slippingCreepOffset = 0
		for (const c of frontlineCreeps) {
			const cToCentroid = c.Position.Subtract(centroid)
			const cFwd = cToCentroid.x * laneDir.x + cToCentroid.y * laneDir.y
			const cLat = cToCentroid.x * lanePerp.x + cToCentroid.y * lanePerp.y

			// Creep is near or ahead of centroid progress
			if (cFwd >= -20) {
				const creepDistToHeroFwd = forwardDist - cFwd
				// If creep is close to hero forward-wise, check if it's outside hero's lateral hull
				if (creepDistToHeroFwd < contactThreshold + 10) {
					const lateralGap = cLat - lateralDist
					if (Math.abs(lateralGap) > 14) {
						slippingCreepOffset = cLat
						break
					}
				}
			}
		}

		// If a creep is slipping around our side, immediately step laterally to shut the door!
		if (slippingCreepOffset !== 0) {
			this.lastActionWasStop = false
			const cutOffPos = centroid
				.Add(laneDir.MultiplyScalar(autoBlockDist))
				.Add(lanePerp.MultiplyScalar(slippingCreepOffset))

			this.targetBlockPos = cutOffPos.Clone()
			hero.MoveTo(cutOffPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// 3B. Pro Zigzag & S-Stop Rhythm:
		// Alternate between:
		// 1) OrderStop (S-tap) -> forces creep to bump and stutter-step
		// 2) Micro-step forward-zigzag (±18 units lateral) -> sweeps an 80-unit wall across the wave
		if (this.lastActionWasStop) {
			// Previous action was STOP: take a quick micro-step forward & zigzag
			this.lastActionWasStop = false
			this.zigzagSide = -this.zigzagSide // Flip lateral side: left <-> right

			const zigzagLateralOffset = this.zigzagSide * 18
			const zigzagPos = centroid
				.Add(laneDir.MultiplyScalar(autoBlockDist + 6))
				.Add(lanePerp.MultiplyScalar(zigzagLateralOffset))

			this.targetBlockPos = zigzagPos.Clone()
			hero.MoveTo(zigzagPos, false, false)

			// Step duration automatically calculated from hero move speed
			const stepMs = Math.round(Math.max(45, Math.min(75, (22 / Math.max(heroSpeed, 250)) * 1000)))
			this.sleeper.Sleep(GameState.InputLag * 1000 + stepMs)
		} else {
			// Previous action was MOVE: tap S (OrderStop) to halt and block
			this.lastActionWasStop = true

			// Dynamic stop duration:
			// Allows creep to bump solidly without giving pathfinder time to route around
			const timeToImpactMs = Math.max(0, ((forwardDist - contactThreshold) / creepSpeed) * 1000)
			const dynamicStopMs = Math.round(Math.max(50, Math.min(85, 45 + timeToImpactMs * 0.4)))

			this.targetBlockPos = hero.Position.Clone()
			hero.OrderStop(false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + dynamicStopMs)
		}
	}
})()
