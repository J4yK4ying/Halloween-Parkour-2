import * as ecs from '@dcl/sdk/ecs'
import {
  engine,
  Name,
  Transform,
  Tween,
  TextShape,
  Entity,
  executeTask,
  GltfContainer
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4, Color3 } from '@dcl/sdk/math'
import { ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { getUserData } from '~system/UserIdentity'

// ==========================================================
// ⚙️ CONFIGURATION
// ==========================================================
const PROJECT_ID = 'leaderboard-for-dcl'
const API_KEY = 'left empty for uploading to github'
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)`
const ADD_DOC_URL = `${FIRESTORE_BASE}/documents/leaderboard?key=${API_KEY}`
const RUN_QUERY_URL = `${FIRESTORE_BASE}/documents:runQuery?key=${API_KEY}`

// ==========================================================
// 🧮 VARIABLES
// ==========================================================
let playerposion = Vector3.create(0, 0, 0)
let collectedCount = 0
const totalCoins = 60
const collectedEntities: Set<number> = new Set()
let showCongrats = false
let newRecordAchieved = false

let timerRunning = false
let startTime = 0
let elapsedTime = 0
let finalTime = 0
let playerName = 'Player'
let playerWallet = '0x0000000000000000000000000000000000000000'

type ScoreEntry = { name: string; time: number }
let leaderboard: ScoreEntry[] = []
let leaderboardEntity: Entity

// ==========================================================
// 🔥 FIREBASE HELPERS
// ==========================================================
async function fetchLeaderboard(): Promise<ScoreEntry[]> {
  try {
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'leaderboard' }],
        orderBy: [{ field: { fieldPath: 'time' }, direction: 'ASCENDING' }],
        limit: 10
      }
    }

    const res = await fetch(RUN_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    })

    const data = await res.json()
    const results: ScoreEntry[] = Array.isArray(data)
      ? data
          .filter((d: any) => d.document)
          .map((d: any) => {
            const f = d.document.fields
            const timeVal = f.time.doubleValue ?? f.time.integerValue ?? 0
            return { name: f.name.stringValue, time: Number(timeVal) }
          })
      : []

    leaderboard = results
    console.log('📊 Leaderboard data:', leaderboard)
    return results
  } catch (err) {
    console.error('❌ Error fetching leaderboard:', err)
    return []
  }
}

async function findAllScoresByWallet(wallet: string): Promise<{ docId: string; time: number }[]> {
  try {
    const queryBody = {
      structuredQuery: {
        from: [{ collectionId: 'leaderboard' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'wallet' },
            op: 'EQUAL',
            value: { stringValue: wallet }
          }
        }
      }
    }

    const res = await fetch(RUN_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody)
    })

    const data = await res.json()
    if (!Array.isArray(data)) return []

    const results: { docId: string; time: number }[] = []
    for (const d of data) {
      if (!d.document) continue
      const docName = d.document.name
      const parts = docName.split('/')
      const docId = parts[parts.length - 1]
      const f = d.document.fields
      const timeVal = f.time.doubleValue ?? f.time.integerValue ?? 0
      results.push({ docId, time: Number(timeVal) })
    }

    return results
  } catch (err) {
    console.error('❌ Error fetching scores by wallet:', err)
    return []
  }
}

async function deleteScoreDoc(docId: string) {
  const docUrl = `${FIRESTORE_BASE}/documents/leaderboard/${docId}?key=${API_KEY}`
  try {
    const res = await fetch(docUrl, { method: 'DELETE' })
    console.log(`🗑️ Deleted old slower score: ${docId}`, res.status)
  } catch (err) {
    console.error('❌ Error deleting score doc:', err)
  }
}

async function updateScoreDoc(docId: string, name: string, wallet: string, time: number) {
  const docUrl = `${FIRESTORE_BASE}/documents/leaderboard/${docId}?key=${API_KEY}`
  const body = {
    fields: {
      name: { stringValue: name },
      wallet: { stringValue: wallet },
      time: { doubleValue: time },
      timestamp: { integerValue: Date.now() }
    }
  }

  try {
    const res = await fetch(docUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const json = await res.json()
    console.log(`🔁 Updated doc ${docId} with faster time ${time.toFixed(2)}s`, json)
  } catch (err) {
    console.error('❌ Error updating score doc:', err)
  }
}

async function uploadScore(name: string, time: number) {
  try {
    const existingScores = await findAllScoresByWallet(playerWallet)
    newRecordAchieved = false

    if (existingScores.length > 0) {
      const best = existingScores.reduce((a, b) => (a.time < b.time ? a : b))
      if (time < best.time) {
        console.log(`🏁 New personal best! ${time.toFixed(2)}s beats ${best.time.toFixed(2)}s`)
        newRecordAchieved = true
        await updateScoreDoc(best.docId, name, playerWallet, time)
        const slower = existingScores.filter((e) => e.docId !== best.docId)
        for (const s of slower) {
          await deleteScoreDoc(s.docId)
        }
      } else {
        console.log(`🕐 Time ${time.toFixed(2)}s is not faster — keeping ${best.time.toFixed(2)}s.`)
      }
      return
    }

    const postBody = {
      fields: {
        name: { stringValue: name },
        wallet: { stringValue: playerWallet },
        time: { doubleValue: time },
        timestamp: { integerValue: Date.now() }
      }
    }

    const postRes = await fetch(ADD_DOC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody)
    })
    const postJson = await postRes.json()
    newRecordAchieved = true
    console.log(`✅ Created new leaderboard entry for ${name}: ${time.toFixed(2)}s`, postJson)
  } catch (err) {
    console.error('❌ Error uploading score:', err)
  }
}

// ==========================================================
// 🕐 TIME FORMATTER
// ==========================================================
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes.toString().padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
}

// ==========================================================
// 🧙 MAIN ENTRY POINT
// ==========================================================
export function main() {
  executeTask(async () => {
    const userData = await getUserData({})
    const data = userData?.data ?? null
    playerName = data?.displayName?.length ? data.displayName : 'Anonymous'
    if (data?.userId) playerWallet = data.userId
    console.log(`🪪 Player identified as: ${playerName} (${playerWallet})`)
  })

  for (const [entity, name] of engine.getEntitiesWith(Name)) {
    const nameVal = Name.get(entity)?.value ?? ''
    if (nameVal.includes('Coin')) {
      Tween.setRotateContinuous(entity, Quaternion.fromEulerDegrees(0, -1, 0), 90)
    }
  }

  leaderboardEntity = createLeaderboardBoard(Vector3.create(9, 11, 1))
  executeTask(async () => {
    leaderboard = await fetchLeaderboard()
  })

  engine.addSystem(MainSystem)
  engine.addSystem(updateBoardSystem)

  // ==========================================================
  // 🎠 Find imported hauntedcarousel by GLTF src and spin smoothly
  // ==========================================================
  let hauntedCarousel: Entity | null = null
  let carouselPivot: Entity | null = null

  for (const [entity, gltf] of engine.getEntitiesWith(GltfContainer)) {
    const src = GltfContainer.get(entity).src?.toLowerCase() ?? ''
    if (src.includes('assets/scene/models/hauntedcarousel/hauntedcarousel.glb')) {
      hauntedCarousel = entity
      console.log('🎠 Found hauntedcarousel via GLTF src:', src)
      break
    }
  }

  if (hauntedCarousel) {
    const original = Transform.get(hauntedCarousel)
    carouselPivot = engine.addEntity()
    Transform.create(carouselPivot, {
      position: original.position,
      rotation: Quaternion.Identity(),
      scale: Vector3.One()
    })

    const transform = Transform.getMutable(hauntedCarousel)
    transform.parent = carouselPivot
    transform.position = Vector3.create(0, 0, 0)

    engine.addSystem((dt: number) => {
      if (!carouselPivot) return
      const pivotTransform = Transform.getMutable(carouselPivot)
      const rotationSpeed = 30
      const step = Quaternion.fromEulerDegrees(0, rotationSpeed * dt, 0)
      pivotTransform.rotation = Quaternion.multiply(pivotTransform.rotation, step)
    })

    console.log('🌀 Haunted carousel spinning smoothly with pivot rotation!')
  } else {
    console.log('⚠️ No hauntedcarousel asset found in GltfContainer entities.')
  }

  // ==========================================================
  // 💡 RANDOM WANDERING + PULSING SPOTLIGHTS — 4×5 PARCEL (64×80 m)
  // ==========================================================
  const PARCEL_SIZE_X = 64     // 4 parcels wide
  const PARCEL_SIZE_Z = 80     // 5 parcels deep
  const NUM_LIGHTS = 12
  const MIN_DISTANCE = 3
  const MOVE_SPEED = 0.6
  const BASE_INTENSITY = 50000   // bright enough for daylight
  const INTENSITY_RANGE = 25000
  const PULSE_SPEED = 1.5

  type MovingLight = { entity: Entity; direction: Vector3; phase: number }
  const movingLights: MovingLight[] = []

  function randomPosition(): Vector3 {
    return Vector3.create(
      Math.random() * PARCEL_SIZE_X,
      6 + Math.random() * 8, // hover height
      Math.random() * PARCEL_SIZE_Z
    )
  }

  function randomDirection(): Vector3 {
    return Vector3.normalize(Vector3.create(Math.random() - 0.5, 0, Math.random() - 0.5))
  }

  function isFarEnough(pos: Vector3): boolean {
    for (const l of movingLights) {
      const other = Transform.get(l.entity).position
      if (Vector3.distance(pos, other) < MIN_DISTANCE) return false
    }
    return true
  }

  function createWanderingSpotlight(position: Vector3): MovingLight {
    const entity = engine.addEntity()
    Transform.create(entity, {
      position,
      rotation: Quaternion.fromEulerDegrees(-90 + Math.random() * 20, Math.random() * 360, 0)
    })

    ecs.LightSource.create(entity, {
      type: ecs.LightSource.Type.Spot({ innerAngle: 15, outerAngle: 45 }),
      color: Color3.create(Math.random(), Math.random(), Math.random()),
      intensity: BASE_INTENSITY,
      range: 25,
      shadow: false
    })

    return { entity, direction: randomDirection(), phase: Math.random() * Math.PI * 2 }
  }

  // ==========================================================
// 🧠 Throttled light spawning (fixes "Message too large" error)
// ==========================================================
let spawnIndex = 0
let spawnDelay = 0

engine.addSystem((dt: number) => {
  spawnDelay += dt
  // spawn one light every 0.3 seconds until all are placed
  if (spawnIndex < NUM_LIGHTS && spawnDelay > 0.3) {
    let pos: Vector3
    let tries = 0
    do {
      pos = randomPosition()
      tries++
    } while (!isFarEnough(pos) && tries < 25)

    const light = createWanderingSpotlight(pos)
    movingLights.push(light)

    // 🧱 Add visible debug cube so you can see positions
    // 👻 Replace tiny cube with a glowing orange ghost sphere
ecs.MeshRenderer.setSphere(light.entity)
ecs.MeshCollider.create(light.entity, { collisionMask: 0 }) // disables collision


// give it a spooky translucent orange glow
ecs.Material.setPbrMaterial(light.entity, {
  albedoColor: Color4.create(1, 0.4, 0, 0.7),      // orange tint
  emissiveColor: Color3.create(1, 0.3, 0),         // glowing orange
  emissiveIntensity: 10,
  metallic: 0,
  roughness: 1
})

// scale up so they’re visible from a distance
const t = Transform.getMutable(light.entity)
t.scale = Vector3.create(0.8, 0.8, 0.8)

// add a gentle rotation & vertical float motion
let floatPhase = Math.random() * Math.PI * 2
engine.addSystem((dt: number) => {
  floatPhase += dt
  const offsetY = Math.sin(floatPhase * 1.5) * 0.5
  t.position.y += offsetY * dt * 2
  t.rotation = Quaternion.multiply(
    t.rotation,
    Quaternion.fromEulerDegrees(0, 45 * dt, 0)
  )
})


    spawnIndex++
    spawnDelay = 0
    console.log(`💡 Spawned light #${spawnIndex}/${NUM_LIGHTS}`)
    
  }
})

  // extra test light near player for visibility check
  const testLight = engine.addEntity()
  Transform.create(testLight, {
    position: Vector3.create(8, 8, 8),
    rotation: Quaternion.fromEulerDegrees(-90, 0, 0)
  })
  ecs.LightSource.create(testLight, {
    type: ecs.LightSource.Type.Spot({ innerAngle: 25, outerAngle: 45 }),
    color: Color3.create(1, 1, 1),
    intensity: 70000,
    range: 30,
    shadow: false
  })
  console.log('💡 Spotlights + test light spawned across 4×5 parcels')

  engine.addSystem((dt: number) => {
    for (const l of movingLights) {
      const transform = Transform.getMutable(l.entity)
      const light = ecs.LightSource.getMutable(l.entity)
      transform.position = Vector3.add(transform.position, Vector3.scale(l.direction, dt * MOVE_SPEED))

      if (
        transform.position.x < 0 || transform.position.x > PARCEL_SIZE_X ||
        transform.position.z < 0 || transform.position.z > PARCEL_SIZE_Z
      ) {
        l.direction = randomDirection()
      }

      l.phase += dt * PULSE_SPEED
      light.intensity = BASE_INTENSITY + Math.sin(l.phase) * INTENSITY_RANGE
    }
  })

  ReactEcsRenderer.setUiRenderer(ui)
}

// ==========================================================
// 🎮 MAIN SYSTEM
// ==========================================================
function MainSystem() {
  const playerTransform = Transform.getOrNull(engine.PlayerEntity)
  if (!playerTransform) return
  playerposion = playerTransform.position
  if (timerRunning) elapsedTime = (Date.now() - startTime) / 1000

  for (const [entity, name] of engine.getEntitiesWith(Name)) {
    const nameVal = Name.get(entity)?.value ?? ''
    if (!nameVal.includes('Coin')) continue
    if (collectedEntities.has(entity)) continue
    const transform = Transform.getMutable(entity)
    const dx = transform.position.x - playerposion.x
    const dz = transform.position.z - playerposion.z
    const horizontalDist = Math.sqrt(dx * dx + dz * dz)
    const verticalDiff = Math.abs(transform.position.y - playerposion.y)
    if (horizontalDist < 1.2 && verticalDiff < 1.5) {
      if (!timerRunning) {
        timerRunning = true
        startTime = Date.now()
      }
      transform.scale = Vector3.create(0, 0, 0)
      collectedEntities.add(entity)
      collectedCount++
      if (collectedCount >= totalCoins) {
        timerRunning = false
        finalTime = elapsedTime
        showCongrats = true
        executeTask(async () => {
          await uploadScore(playerName, finalTime)
          leaderboard = await fetchLeaderboard()
          console.log(`📡 Leaderboard updated for ${playerName}:`, finalTime)
        })
      }
    }
  }
}

// ==========================================================
// 🪶 LEADERBOARD DISPLAY
// ==========================================================
function createLeaderboardBoard(position: Vector3) {
  const textEntity = engine.addEntity()
  Transform.create(textEntity, {
    position,
    scale: Vector3.create(1.6, 1.6, 1.6),
    rotation: Quaternion.fromEulerDegrees(0, 180, 0)
  })
  TextShape.create(textEntity, {
    text: 'Loading Leaderboard...',
    fontSize: 4,
    textColor: Color4.White(),
    textAlign: 1,
    width: 10,
    height: 6
  })
  return textEntity
}

function updateBoardSystem() {
  if (!leaderboardEntity || !TextShape.has(leaderboardEntity)) return
  const t = TextShape.getMutable(leaderboardEntity)
  t.text =
    '🏆 Top 10 Players 🏆\n\n' +
    (leaderboard.length
      ? leaderboard.map((entry, i) => `${i + 1}. ${entry.name.padEnd(8)} ${formatTime(entry.time)}`).join('\n')
      : 'No scores yet!')
}

// ==========================================================
// 🧠 UI (Coin Counter + Timer + Congrats)
// ==========================================================
function ui() {
  const elements: any[] = []
  elements.push(
    UiEntity({
      uiTransform: { width: 220, height: 60, margin: '10px', alignItems: 'center', justifyContent: 'center', positionType: 'absolute', position: { top: 10, right: 60 } },
      uiBackground: { color: { r: 0, g: 0, b: 0, a: 0.55 } },
      uiText: {
        value: `Coins: ${collectedCount}/${totalCoins}  |  ${
          timerRunning ? `Time: ${formatTime(elapsedTime)}` : finalTime > 0 ? `Final: ${formatTime(finalTime)}` : 'Time: 00:00.00'
        }`,
        fontSize: 18,
        color: { r: 1, g: 1, b: 0.8, a: 1 }
      }
    })
  )

  if (showCongrats) {
    elements.push(
      UiEntity({
        uiTransform: { width: 320, height: 100, alignItems: 'center', justifyContent: 'center', positionType: 'absolute', position: { top: 10, right: 350 } },
        uiBackground: { color: { r: 0, g: 0, b: 0, a: 0.85 } },
        uiText: {
          value: newRecordAchieved
            ? `🏁 New Personal Best, ${playerName}! 🏁\nTime: ${formatTime(finalTime)}`
            : `🎉 Congratulations, ${playerName}! 🎉\nFinal Time: ${formatTime(finalTime)}`,
          fontSize: 18,
          color: newRecordAchieved ? { r: 0.5, g: 1, b: 0.5, a: 1 } : { r: 1, g: 1, b: 1, a: 1 },
          textAlign: 'middle-center'
        }
      }),
      UiEntity({
        uiTransform: { width: 24, height: 24, positionType: 'absolute', position: { top: 14, right: 365 }, justifyContent: 'center', alignItems: 'center' },
        uiBackground: { color: { r: 0.3, g: 0.3, b: 0.3, a: 0.8 } },
        uiText: { value: '✖', fontSize: 16, color: { r: 1, g: 0.6, b: 0.6, a: 1 } },
        onMouseDown: () => {
          showCongrats = false
        }
      })
    )
  }

  return elements
}
