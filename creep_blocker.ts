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
		"Highlights the lead creep with a green ring and displays the intercept point on screen"
	)

	private readonly sleeper = new TickSleeper()

	private leadCreep: Creep | undefined = undefined
	private targetBlockPos: Vector3 | undefined = undefined
	private isCurrentlyBlocking = false
	private lastOrderWasHold = false

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
		this.lastOrderWasHold = false
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
				RendererSDK.OutlinedCircle(creepScreen, new Vector2(30, 30), Color.Green, 2)
			}
		}

		if (this.targetBlockPos) {
			const blockScreen = RendererSDK.WorldToScreen(this.targetBlockPos)
			if (blockScreen) {
				RendererSDK.OutlinedCircle(blockScreen, new Vector2(18, 18), Color.Aqua, 2)
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
		let validDirCount = 0
		for (const c of allyCreeps) {
			if (c.Forward.Length2D > 0.05) {
				sumX += c.Forward.x
				sumY += c.Forward.y
				validDirCount++
			}
		}

		let waveDir: Vector3
		if (validDirCount > 0) {
			waveDir = new Vector3(sumX, sumY, 0).Normalize()
		} else if (hero.Forward.Length2D > 0.1) {
			waveDir = hero.Forward.Clone().SetZ(0).Normalize()
		} else {
			waveDir = new Vector3(1, 0, 0)
		}

		// 4. Identify the Lead Creep (furthest along waveDir)
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

		// 5. Creep orientation & vectors
		let creepDir = bestLeadCreep.Forward.Clone()
		creepDir.SetZ(0)
		creepDir = creepDir.Length2D > 0.1 ? creepDir.Normalize() : waveDir

		const perp = new Vector3(-creepDir.y, creepDir.x, 0)
		const toHero = hero.Position.Subtract(bestLeadCreep.Position)
		toHero.SetZ(0)

		const forwardDist = toHero.x * creepDir.x + toHero.y * creepDir.y
		const lateralDist = toHero.x * perp.x + toHero.y * perp.y

		// 6. DYNAMIC & AUTOMATIC PHYSICAL CALCULATIONS
		const heroHull = hero.HullRadius > 0 ? hero.HullRadius : 24
		const creepHull = bestLeadCreep.HullRadius > 0 ? bestLeadCreep.HullRadius : 16
		const contactThreshold = heroHull + creepHull // ~40 units

		const heroSpeed = hero.MoveSpeed
		const creepSpeed = Math.max(bestLeadCreep.MoveSpeed, 1)

		// Dynamic Block Distance:
		// If hero is slower than creep, hug as close as possible (contactThreshold + 3 = ~43)
		// If hero is faster, allow a slightly larger buffer (up to 52) to absorb bumps smoothly
		const speedDelta = heroSpeed - creepSpeed
		const autoBlockDist = contactThreshold + Math.max(3, Math.min(12, 4 + speedDelta * 0.1))

		// Dynamic Micro-Stop Duration (ms):
		// Automatically scaled to bleed creep velocity without allowing creep pathfinder to recalculate around flanks
		const timeToImpactMs = Math.max(0, ((forwardDist - contactThreshold) / creepSpeed) * 1000)
		const dynamicStopMs = Math.round(Math.max(50, Math.min(105, 65 + timeToImpactMs * 0.5)))

		claimOrder()
		setCreepBlockingActive(true)
		this.isCurrentlyBlocking = true

		// CASE 1: HERO IS BEHIND THE LEAD CREEP (Needs to overtake and get in front)
		if (forwardDist < autoBlockDist - 5) {
			this.lastOrderWasHold = false
			const overtakeAhead = Math.max(autoBlockDist + 30, autoBlockDist + (autoBlockDist - forwardDist) * 0.8)

			// If directly in line with creep's back, flank to the side to avoid bumping creep's rear hull
			let targetPos: Vector3
			if (forwardDist < 10) {
				const flankSide = lateralDist >= 0 ? 1 : -1
				const flankOffset = perp.MultiplyScalar(flankSide * Math.max(35, creepHull + heroHull + 5))
				targetPos = bestLeadCreep.Position.Add(creepDir.MultiplyScalar(overtakeAhead)).Add(flankOffset)
			} else {
				targetPos = bestLeadCreep.Position.Add(creepDir.MultiplyScalar(overtakeAhead))
			}

			this.targetBlockPos = targetPos.Clone()
			hero.MoveTo(targetPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
			return
		}

		// CASE 2: HERO IS FAR AHEAD (Prepare position directly on the creep's line of march)
		// Stand right on the centerline of the incoming creep so the creep cannot bypass!
		if (forwardDist > autoBlockDist + 25) {
			const interceptDist = Math.min(forwardDist, autoBlockDist + 35)
			const centerlinePos = bestLeadCreep.Position.Add(creepDir.MultiplyScalar(interceptDist))
			this.targetBlockPos = centerlinePos.Clone()

			// If hero is off the centerline by > 12 units, step onto the centerline!
			if (Math.abs(lateralDist) > 12) {
				this.lastOrderWasHold = false
				hero.MoveTo(centerlinePos, false, false)
				this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
				return
			}

			// Already on the centerline, hold position waiting for the creep to arrive!
			this.lastOrderWasHold = true
			hero.HoldPosition(hero.Position, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + dynamicStopMs)
			return
		}

		// CASE 3: ACTIVE BODY BLOCK ZONE (Hero is right in front of the creep)
		const idealBlockPos = bestLeadCreep.Position.Add(creepDir.MultiplyScalar(autoBlockDist))
		this.targetBlockPos = idealBlockPos.Clone()

		// If creep is veering or hero is slipping off the center line (> 14 units):
		// Steer immediately to cut off the bypass!
		if (Math.abs(lateralDist) > 14) {
			this.lastOrderWasHold = false
			hero.MoveTo(idealBlockPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// Creep is right behind hero!
		// If creep is in physical hull contact (forwardDist <= contactThreshold + 3):
		// Take a micro-step forward to maintain distance and prevent slipping
		if (forwardDist <= contactThreshold + 3 || this.lastOrderWasHold) {
			this.lastOrderWasHold = false
			const microStepPos = bestLeadCreep.Position.Add(creepDir.MultiplyScalar(autoBlockDist + 12))
			hero.MoveTo(microStepPos, false, false)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// Creep is approaching and about to bump: HOLD POSITION to act as a solid brick wall!
		this.lastOrderWasHold = true
		hero.HoldPosition(hero.Position, false, false)
		this.sleeper.Sleep(GameState.InputLag * 1000 + dynamicStopMs)
	}
})()
