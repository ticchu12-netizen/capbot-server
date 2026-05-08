/**
 * ONNX brain inference for Capbot autonomous battles.
 *
 * The model was trained via ML-Agents PPO with self-play (~58M steps, marketed as 60M)
 * on all three character types in random matchups. It expects:
 *   - obs_0:        float32 [1, 192]   3 stacked frames of 64-dim observation (oldest first)
 *   - action_masks: float32 [1, 4]     1 = move usable, 0 = masked
 *   - recurrent_in: float32 [1, 1, 512] all zeros — the model graph keeps a recurrent
 *                                        input for ML-Agents compat but is not actually
 *                                        recurrent (no memory_out output)
 *
 * Output:
 *   - deterministic_discrete_actions: int64 (or int32) [1, 1] — argmax action index 0..3
 *
 * One InferenceSession is reused across all battles. Lazy-loaded on first call.
 */

const ort = require('onnxruntime-node');
const path = require('path');

const BRAIN_PATH = path.resolve(__dirname, 'brain', 'CapmonAI-57999998.onnx');

let session = null;
let loadPromise = null;

// 1*1*512 float32 zeros, reused on every call (cheap clone)
const ZERO_MEMORY = new Float32Array(512);

async function loadBrain() {
    if (session) return session;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        session = await ort.InferenceSession.create(BRAIN_PATH, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        });
        console.log('[brain] loaded:', BRAIN_PATH);
        console.log('[brain] inputs:', session.inputNames.join(', '));
        console.log('[brain] outputs:', session.outputNames.join(', '));
        return session;
    })();
    return loadPromise;
}

/**
 * Run the brain on a single observation and return the chosen move index (0..3).
 * Falls back to -1 on failure — caller should default to a uniform RL prob distribution.
 */
async function pickMoveViaOnnx(stackedObs192, actionMasks4) {
    const sess = await loadBrain();

    const obsTensor   = new ort.Tensor('float32', Float32Array.from(stackedObs192), [1, 192]);
    const masksTensor = new ort.Tensor('float32', Float32Array.from(actionMasks4),  [1, 4]);
    const memTensor   = new ort.Tensor('float32', ZERO_MEMORY.slice(),              [1, 1, 512]);

    const feeds = {
        obs_0: obsTensor,
        action_masks: masksTensor,
        recurrent_in: memTensor,
    };

    const results = await sess.run(feeds);
    const out = results['deterministic_discrete_actions'];
    if (!out) {
        throw new Error('Output deterministic_discrete_actions not found in model');
    }

    // out.data may be BigInt64Array (int64) or Int32Array — Number() handles both
    const action = Number(out.data[0]);
    return action;
}

module.exports = { loadBrain, pickMoveViaOnnx };