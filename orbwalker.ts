import {
	dotaunitorder_t,
	ExecuteOrder,
	GameState,
	Hero,
	TickSleeper
} from "github.com/octarine-public/wrapper/index"

export interface OrbwalkConfig {
	enabled: boolean
	safeDistancePct: number // 0–100, % of attack range to maintain
	/** If true, issue STOP before MOVE during backswing cancel for crisper animation break */
	stopToCancel: boolean
}

const SLEEP_AFTER_MOVE = 100
const SLEEP_AFTER_ATTACK = 100
const SLEEP_SIMPLE_ATTACK = 150

const ATTACK_TOLERANCE = 0.05 // seconds before bat expires, start attack

/**
 * Core orbwalk execution.
 * Returns true if an order was issued, false if skipped (sleeping, no target).
 */
export function executeOrbwalk(
	hero: Hero,
	target: Hero | undefined,
	sleeper: TickSleeper,
	config: OrbwalkConfig
): boolean {
	if (sleeper.Sleeping) {
		return false
	}

	if (!target || !target.IsValid || !target.IsAlive) {
		return false
	}

	if (!config.enabled) {
		return simpleAttack(hero, target, sleeper)
	}

	return smartOrbwalk(hero, target, sleeper, config)
}

function smartOrbwalk(
	hero: Hero,
	target: Hero,
	sleeper: TickSleeper,
	config: OrbwalkConfig
): boolean {
	const isAttackingAnimation = hero.IsInAnimation && hero.LastAnimationIsAttack

	if (isAttackingAnimation) {
		const elapsed = GameState.RawGameTime - hero.LastAnimationStartTime
		const attackPoint = hero.AttackPoint

		// Still winding up — wait for projectile/melee hit
		if (elapsed < attackPoint) {
			return true
		}

		// Past attack point — cancel backswing
		if (config.stopToCancel) {
			// STOP first for instant animation break on some heroes
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_STOP,
				issuers: [hero],
				queue: false,
				showEffects: false,
				isPlayerInput: false
			})
			sleeper.Sleep(SLEEP_AFTER_ATTACK)
			return true
		}

		const movePos = calcOrbwalkPosition(hero, target, config.safeDistancePct)
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
			issuers: [hero],
			position: movePos,
			queue: false,
			showEffects: false,
			isPlayerInput: false
		})
		sleeper.Sleep(SLEEP_AFTER_MOVE)
		return true
	}

	// Not in attack animation
	const timeSinceLastAttack = GameState.RawGameTime - hero.LastAttackTime
	const secondsPerAttack = hero.SecondsPerAttack

	if (timeSinceLastAttack >= secondsPerAttack - ATTACK_TOLERANCE) {
		// Attack is ready
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
			issuers: [hero],
			target: target.Index,
			queue: false,
			showEffects: false,
			isPlayerInput: false
		})
		sleeper.Sleep(SLEEP_AFTER_ATTACK)
		return true
	}

	// Attack on cooldown — move to maintain orbital distance
	const movePos = calcOrbwalkPosition(hero, target, config.safeDistancePct)
	ExecuteOrder.PrepareOrder({
		orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
		issuers: [hero],
		position: movePos,
		queue: false,
		showEffects: false,
		isPlayerInput: false
	})
	sleeper.Sleep(SLEEP_AFTER_MOVE)
	return true
}

function calcOrbwalkPosition(hero: Hero, target: Hero, safeDistancePct: number) {
	const dir = target.Position.Subtract(hero.Position)
	const dist = dir.Length2D
	const safeDist = hero.GetAttackRange(target) * (safeDistancePct / 100)

	if (dist > 1) {
		// Normal case — kite to safe distance
		return target.Position.Subtract(dir.Normalize().MultiplyScalar(safeDist))
	}

	// Target and hero are on top of each other — move perpendicular
	const perp = { x: dir.y ?? 1, y: -(dir.x ?? 0) }
	perp.x = perp.x || 1
	perp.y = perp.y ?? 0
	const len = Math.sqrt(perp.x * perp.x + perp.y * perp.y)
	if (len > 0) {
		return target.Position.Add({
			x: (perp.x / len) * safeDist,
			y: (perp.y / len) * safeDist
		})
	}

	// Ultimate fallback — move east
	return target.Position.Add({ x: safeDist, y: 0 })
}

function simpleAttack(hero: Hero, target: Hero, sleeper: TickSleeper): boolean {
	// If target is beyond attack range, move closer first
	if (hero.Distance2D(target) > hero.GetAttackRange(target)) {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
			issuers: [hero],
			position: target.Position,
			queue: false,
			showEffects: false,
			isPlayerInput: false
		})
		sleeper.Sleep(SLEEP_AFTER_MOVE)
		return true
	}

	// Don't spam attack orders on the same target
	const currentTarget = hero.Target
	if (currentTarget && currentTarget.Index === target.Index) {
		return false
	}

	ExecuteOrder.PrepareOrder({
		orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
		issuers: [hero],
		target: target.Index,
		queue: false,
		showEffects: false,
		isPlayerInput: false
	})
	sleeper.Sleep(SLEEP_SIMPLE_ATTACK)
	return true
}
