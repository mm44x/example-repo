# Graph Report - example-repo  (2026-08-26)

## Corpus Check
- 31 files · ~42,348 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 481 nodes · 700 edges · 27 communities (20 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9c2275ca`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- rules
- executeOrbwalk
- tinker_combo.ts
- auto_save.ts
- devDependencies
- compilerOptions
- package.json
- .eslintrc.json
- index.ts
- invoker_combo.ts
- rubick_combo.ts
- error
- CustomLastHit
- anti_initiation.ts
- warn
- auto_dodger.ts
- id-denylist
- one-var
- Snatcher Reference
- Claude Code Guidance
- Installation Guide
- Event System Architecture
- Menu System Architecture
- Humanizer and Sleep Pattern
- pugna_combo.ts
- rules/graphify.md
- workflows/graphify.md

## God Nodes (most connected - your core abstractions)
1. `rules` - 125 edges
2. `PostDataUpdate()` - 23 edges
3. `executeOrbwalk()` - 21 edges
4. `handleFarmLoop()` - 16 edges
5. `PostDataUpdate()` - 14 edges
6. `compilerOptions` - 14 edges
7. `PostDataUpdate()` - 13 edges
8. `error` - 11 edges
9. `CustomLastHit` - 10 edges
10. `handleAutoFarm()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  invoker_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  magnus_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  pugna_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  rubick_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  tinker_combo.ts → orbwalker.ts

## Import Cycles
- None detected.

## Communities (27 total, 7 thin omitted)

### Community 0 - "rules"
Cohesion: 0.02
Nodes (106): rules, block-spacing, comma-dangle, comma-spacing, complexity, constructor-super, dot-notation, eol-last (+98 more)

### Community 1 - "executeOrbwalk"
Cohesion: 0.08
Nodes (23): executeAutoRhapsodySpells(), executeComboAbility(), handleRhapsodySongHotkeys(), PostDataUpdate(), PostDataUpdate(), calcOrbwalkPosition(), executeOrbwalk(), OrbwalkConfig (+15 more)

### Community 2 - "tinker_combo.ts"
Cohesion: 0.11
Nodes (40): castKeenConveyance(), castNoTarget(), castPosition(), castTarget(), COMBO_SPELLS, debugSpellInfo, doBlink(), Draw() (+32 more)

### Community 3 - "auto_save.ts"
Cohesion: 0.16
Nodes (20): FATAL_MODIFIERS, getEnemyCasterOfThreat(), getOrderedAllies(), hasActiveSaveOrImmunity(), hasActiveThreatModifier(), hasFatalDebuff(), INSTANT_REFLECTABLE_SPELLS, isAboutToBeTargetedByReflectableThreat() (+12 more)

### Community 4 - "devDependencies"
Cohesion: 0.08
Nodes (25): eslint, eslint-config-prettier, eslint-plugin-import, eslint-plugin-jsdoc, eslint-plugin-prettier, eslint-plugin-simple-import-sort, eslint-plugin-unicorn, eslint-plugin-unused-imports (+17 more)

### Community 5 - "compilerOptions"
Cohesion: 0.09
Nodes (22): ../../**/*.d.ts, ESNext, ./**/*.ts, compileOnSave, compilerOptions, alwaysStrict, baseUrl, experimentalDecorators (+14 more)

### Community 6 - "package.json"
Cohesion: 0.09
Nodes (21): contributors, description, license, name, repository, directory, type, url (+13 more)

### Community 7 - ".eslintrc.json"
Cohesion: 0.11
Nodes (19): env, es6, extends, ignorePatterns, node_modules/**/*, scripts_files/**/*, parser, parserOptions (+11 more)

### Community 8 - "index.ts"
Cohesion: 0.11
Nodes (10): SmartArmletAbuse, constructor(), isSelectionState(), onGameStateChanged(), onPostDataUpdate(), populateAndRefresh(), updateBans(), getHeroPrimaryAttribute() (+2 more)

### Community 9 - "invoker_combo.ts"
Cohesion: 0.21
Nodes (14): angleDifference(), castInvokerSpell(), executeComboAbility(), getActiveIceWallAbility(), getIceWallCastPoints(), hasScepter(), invokeSpell(), isIceWallName() (+6 more)

### Community 10 - "rubick_combo.ts"
Cohesion: 0.23
Nodes (9): AbilityCooldownChanged(), executeStolenSpells(), getAdjustedRect(), IsAbilityVisibleOnHUD(), isValidSpell(), NATIVE_SPELLS, OnDraw(), OnMouseKeyDown() (+1 more)

### Community 11 - "error"
Cohesion: 0.15
Nodes (13): eqeqeq, prettier/prettier, @typescript-eslint/array-type, @typescript-eslint/ban-types, @typescript-eslint/consistent-type-imports, @typescript-eslint/explicit-member-accessibility, @typescript-eslint/naming-convention, @typescript-eslint/no-shadow (+5 more)

### Community 12 - "CustomLastHit"
Cohesion: 0.27
Nodes (3): CustomLastHit, lastHitSleeper, sleepTime()

### Community 13 - "anti_initiation.ts"
Cohesion: 0.27
Nodes (7): checkAndCastAntiInitiation(), Draw(), getCandidates(), getItemConfigs(), PostDataUpdate(), SpellConfig, SUPPORTED_SPELLS

### Community 14 - "warn"
Cohesion: 0.20
Nodes (10): arrow-parens, curly, func-style, object-curly-spacing, unused-imports/no-unused-vars, all, always, as-needed (+2 more)

### Community 15 - "auto_dodger.ts"
Cohesion: 0.13
Nodes (12): executeAndClaimOrder(), FATAL_MODIFIERS, getDangerAoEAnimations(), getThreatProjectileTimeToImpact(), hasFatalDebuff(), MAGIC_THREAT_ABILITIES, PostDataUpdate(), THREAT_ABILITIES (+4 more)

### Community 16 - "id-denylist"
Cohesion: 0.33
Nodes (6): id-denylist, any, Boolean, Number, String, Undefined

### Community 17 - "one-var"
Cohesion: 0.50
Nodes (5): one-var, @typescript-eslint/member-delimiter-style, @typescript-eslint/semi, never, off

### Community 18 - "Snatcher Reference"
Cohesion: 0.67
Nodes (3): Entry Point Pattern, Lasthit Marker Reference, Snatcher Reference

### Community 24 - "pugna_combo.ts"
Cohesion: 0.18
Nodes (18): castNoTarget(), castPosition(), castTarget(), clampToCastRange(), COMBO_SPELLS, doBlink(), Draw(), drawPanel() (+10 more)

## Knowledge Gaps
- **202 isolated node(s):** `root`, `node_modules/**/*`, `scripts_files/**/*`, `es6`, `parser` (+197 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `rules` connect `rules` to `.eslintrc.json`, `error`, `warn`, `id-denylist`, `one-var`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **Why does `executeOrbwalk()` connect `executeOrbwalk` to `pugna_combo.ts`, `invoker_combo.ts`, `rubick_combo.ts`, `tinker_combo.ts`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **What connects `root`, `node_modules/**/*`, `scripts_files/**/*` to the rest of the system?**
  _202 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `rules` be split into smaller, more focused modules?**
  _Cohesion score 0.018867924528301886 - nodes in this community are weakly interconnected._
- **Should `executeOrbwalk` be split into smaller, more focused modules?**
  _Cohesion score 0.07610993657505286 - nodes in this community are weakly interconnected._
- **Should `tinker_combo.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11416490486257928 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._