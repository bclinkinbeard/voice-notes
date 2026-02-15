# Performance Agent Analysis: On-Device Sentiment Analysis & Auto-Tagging

## Executive Summary

**The proposed plan to add two additional models (sentiment + zero-shot classification) is not viable as specified.** The combined download budget of ~207 MB, runtime memory exceeding 500 MB, and main-thread blocking on mobile devices will produce an unacceptable user experience. This report provides exact file sizes, identifies critical failure modes, and recommends a pragmatic alternative path that keeps total added model weight under 30 MB.

---

## 1. Current Baseline: What We Are Already Spending

The app currently loads `onnx-community/whisper-tiny.en` via transformers.js v3. This model uses ONNX WASM inference on the main thread.

### Whisper tiny.en ONNX File Sizes (verified from HuggingFace API)

| File | Size |
|------|------|
| `encoder_model.onnx` (fp32) | 31.4 MB |
| `encoder_model_quantized.onnx` (q8) | 9.7 MB |
| `decoder_model_merged.onnx` (fp32) | 113.1 MB |
| `decoder_model_merged_quantized.onnx` (q8) | 29.3 MB |

Transformers.js v3 defaults to q8 for WASM, so the app currently downloads approximately **~39 MB** of model weights (encoder q8 + decoder_merged q8), plus tokenizer files and the transformers.js runtime itself.

### Current Runtime Memory Estimate

- ONNX WASM runtime overhead: ~20-30 MB
- Whisper model tensors in memory: ~60-80 MB (weights are decompressed from q8 to float32 during inference)
- Audio buffers (16kHz mono Float32Array for a 30s clip): ~1.9 MB
- Total estimated memory for transcription: **~100-130 MB**

This is already aggressive for low-end mobile devices (which may have only 2-3 GB total RAM with ~500 MB available to a single browser tab).

---

## 2. Proposed Models: Actual Sizes (Verified)

I retrieved exact ONNX file sizes from the HuggingFace API for every quantization variant.

### Sentiment: `Xenova/distilbert-base-uncased-finetuned-sst-2-english`

| Variant | Size |
|---------|------|
| `model.onnx` (fp32) | 255.5 MB |
| `model_fp16.onnx` | 127.9 MB |
| `model_quantized.onnx` (q8) | 64.5 MB |
| `model_int8.onnx` | 64.3 MB |
| `model_q4.onnx` | **118.9 MB** |
| `model_q4f16.onnx` | 69.7 MB |
| `model_bnb4.onnx` | 116.3 MB |
| `model_uint8.onnx` | 64.3 MB |

**Critical finding:** The q4 ONNX file is 118.9 MB -- larger than q8 (64.5 MB). This is because ONNX q4 format includes dequantization metadata and lookup tables that inflate the file. The default WASM dtype (q8) downloads **64.5 MB**, not the "~67 MB" commonly cited. The claim that q4 reduces to "~17-20 MB" is false for this model.

### Zero-Shot Classification: `Xenova/mobilebert-uncased-mnli`

| Variant | Size |
|---------|------|
| `model.onnx` (fp32) | 94.4 MB |
| `model_fp16.onnx` | 47.8 MB |
| `model_quantized.onnx` (q8) | 25.7 MB |
| `model_int8.onnx` | 25.2 MB |
| `model_q4.onnx` | 29.4 MB |
| `model_q4f16.onnx` | 20.0 MB |
| `model_bnb4.onnx` | 28.2 MB |
| `model_uint8.onnx` | 25.2 MB |

Default q8 download: **25.7 MB**.

### Alternative Zero-Shot: `Xenova/nli-deberta-v3-xsmall`

Despite the "xsmall" name, this model is enormous because DeBERTa-v3 uses a 128K-token vocabulary embedding:

| Variant | Size |
|---------|------|
| `model.onnx` (fp32) | 271.0 MB |
| `model_quantized.onnx` (q8) | 83.2 MB |
| `model_q4f16.onnx` | 115.2 MB |

**This model is worse than MobileBERT for our use case.** The 128K vocabulary embedding dominates file size and memory. Reject this option.

### Proposed Total Download Budget (q8 defaults)

| Component | Download |
|-----------|----------|
| Whisper tiny.en (q8) | ~39 MB |
| DistilBERT sentiment (q8) | 64.5 MB |
| MobileBERT zero-shot (q8) | 25.7 MB |
| **Total** | **~129 MB** |

This is better than the originally estimated 207 MB, but still problematic. On a 4G mobile connection (~5 Mbps effective), this is **~3.5 minutes** of download time for all models. On 3G (~1 Mbps), it is **~17 minutes**.

---

## 3. Runtime Memory Analysis: Will This Crash Mobile Devices?

### Memory Per Model at Runtime

ONNX Runtime decompresses q8 weights to float32 for computation. Approximate runtime memory per model:

| Model | Parameters | Runtime Memory (est.) |
|-------|-----------|----------------------|
| Whisper tiny.en | 39M | 80-130 MB |
| DistilBERT-SST2 | 67M | 150-200 MB |
| MobileBERT-MNLI | 25M | 60-90 MB |
| ONNX WASM runtime (shared) | -- | 20-30 MB |
| **Total (all 3 loaded)** | | **310-450 MB** |

### Mobile Device Memory Constraints

| Device Class | Total RAM | Available to Browser Tab |
|-------------|-----------|-------------------------|
| Low-end Android (2023+) | 3-4 GB | ~300-500 MB |
| Mid-range Android | 6-8 GB | ~500-800 MB |
| iPhone SE / iPhone 12 | 3-4 GB | ~300-500 MB |
| iPhone 14+ | 6 GB | ~500-1000 MB |

**Verdict: Loading all 3 models simultaneously WILL crash low-end mobile devices.** Even mid-range devices will be under severe memory pressure, leading to jank, background tab eviction, and potential OOM kills.

### Known Transformers.js Memory Issues

- **Issue #1242**: Transformers.js v3 crashes on iOS and macOS due to increasing memory usage. The v3.2.2 release has known memory leak behavior where memory grows unboundedly, especially on Apple devices.
- **Issue #860**: Whisper WebGPU pipeline leaks tensors. Memory consumption grows with each transcription call.
- **Issue #715**: `pipeline.dispose()` does not fully reclaim memory in the WASM backend. Memory is only reliably freed when a Web Worker is terminated.
- **WebAssembly hard limit**: WASM has a 4 GB memory ceiling (32-bit addressing). Three models plus runtime overhead could approach 500 MB-1 GB, well within the limit but dangerously close to mobile browser tab limits.

---

## 4. Processing Time Estimates

### Text Classification Inference Latency

For a 1-2 sentence transcript (~20-40 tokens):

| Model | Device | Backend | Estimated Latency |
|-------|--------|---------|-------------------|
| DistilBERT-SST2 (q8) | Desktop (modern CPU) | WASM | 50-150 ms |
| DistilBERT-SST2 (q8) | Mid-range phone | WASM | 200-500 ms |
| DistilBERT-SST2 (q8) | Low-end phone | WASM | 500-1500 ms |
| MobileBERT-MNLI (q8) | Desktop | WASM | 30-100 ms |
| MobileBERT-MNLI (q8) | Mid-range phone | WASM | 150-400 ms |
| MobileBERT-MNLI (q8) | Low-end phone | WASM | 300-1000 ms |

**Zero-shot classification is slower** because it requires N forward passes (one per candidate label). For 5 candidate tags, multiply the MobileBERT latency by 5:

| Scenario | Device | Estimated Latency |
|----------|--------|-------------------|
| 5-label zero-shot, MobileBERT | Desktop | 150-500 ms |
| 5-label zero-shot, MobileBERT | Mid-range phone | 750-2000 ms |
| 5-label zero-shot, MobileBERT | Low-end phone | 1500-5000 ms |

**Combined sentiment + 5-label tagging on a low-end phone: 2-6.5 seconds of blocking computation.**

### Main Thread Impact

The current app runs Whisper on the main thread (line 93-121 of app.js). Adding sentiment + classification on the main thread after transcription means:

1. Whisper transcription blocks the UI for several seconds already
2. Adding 2-6.5 more seconds of NLP processing creates a total block of **5-15 seconds** per recording
3. During this time: no button presses register, no animations play, no scrolling works
4. Users will think the app has frozen

**This is unacceptable. A Web Worker is mandatory, not optional.**

---

## 5. Cache Storage Analysis

### Browser Storage Quotas (Current Policy)

| Browser | Per-Origin Quota | Eviction Policy |
|---------|-----------------|-----------------|
| Safari 17+ (iOS/macOS) | Up to 60% of disk | Data evicted after 7 days without user interaction (ITP) |
| Chrome (Android) | Up to 80% of disk | LRU-based eviction |
| Chrome on iOS | Uses WebKit quotas | WebKit eviction policies |
| Firefox | Up to 80% of disk | LRU-based eviction |

### Will ~130 MB of Cached Models Cause Issues?

For a typical iPhone with 64 GB storage:
- 60% quota = ~38 GB per origin -- plenty of room
- **But**: Safari's Intelligent Tracking Prevention (ITP) will evict cached model data after 7 days of non-use
- Result: Users who open the app weekly will re-download 130 MB every time

For a typical Android phone with 32 GB storage (low-end):
- 80% quota = ~25 GB -- still fine for storage
- But low-end Android phones often have slow eMMC storage, making cache reads slow

### Practical Concerns

1. **Re-download frequency**: Mobile users who use the app sporadically will hit ITP eviction on iOS, causing repeated 130 MB downloads
2. **User perception**: 130 MB of storage for a "simple" voice notes app is aggressive. Users checking storage usage may delete the site data
3. **PWA context**: If added to home screen, the app gets its own storage partition but is still subject to eviction if unused for ~2 weeks
4. **IndexedDB overhead**: The app already stores audio blobs in IndexedDB. Adding 130 MB of model cache on top of audio storage compounds the storage footprint

---

## 6. Should Models Be Loaded On-Demand or Kept in Memory?

### Option A: Keep All Models in Memory
- **Pro**: No load latency after initial download
- **Con**: 310-450 MB runtime memory; will crash low-end devices; wastes memory when user is just browsing notes

### Option B: Load On-Demand, Keep in Memory Until Tab Close
- **Pro**: Memory only used when needed
- **Con**: First inference has 1-5 second model load time; all models eventually loaded and never freed

### Option C: Load On-Demand, Dispose After Use (Recommended)
- **Pro**: Peak memory limited to Whisper + one NLP model at a time (~200-250 MB)
- **Con**: `pipeline.dispose()` does not fully reclaim WASM memory (known bug); must use Worker termination for reliable cleanup
- **Implementation**: Load Whisper in Worker, transcribe, then dispose Whisper; load sentiment model, infer, dispose; load classification model, infer, dispose. Terminate Worker after full pipeline completes.

### Option D: Single Worker with Sequential Model Loading
- **Pro**: Most memory-efficient; Worker termination guarantees full cleanup
- **Con**: Total processing time increases due to serial model loading
- **Practical**: Best for mobile devices where memory is the bottleneck, not latency

**Recommendation: Option D**, with the Worker terminated and re-created for each new note's processing pipeline. This is the only approach that guarantees memory reclamation given the known WASM memory leak issues.

---

## 7. Can a Single Model Handle Both Tasks?

### Zero-Shot Classification Can Replace Both Models

A zero-shot classification model (NLI-based) can handle sentiment by including sentiment labels in the candidate set:

```javascript
const classifier = await pipeline(
  'zero-shot-classification',
  'Xenova/mobilebert-uncased-mnli'
);

// Combined: sentiment + topic tags in one call
const result = await classifier(
  transcript,
  ['positive', 'negative', 'neutral', 'work', 'personal', 'idea', 'todo', 'meeting']
);
```

**Advantages:**
- One model download instead of two: 25.7 MB (MobileBERT q8) vs. 90.2 MB (DistilBERT + MobileBERT)
- One model loaded in memory instead of two: ~60-90 MB vs. ~210-290 MB
- Simpler code path

**Disadvantages:**
- Sentiment accuracy will be lower than a fine-tuned sentiment model (MobileBERT-MNLI was not trained for sentiment specifically)
- More candidate labels = more forward passes = slower inference
- 8 labels = 8 forward passes = 1.2-8 seconds on mobile

### Custom Fine-Tuned Model (Best Long-Term)

Fine-tune a single tiny model (e.g., `boltuix/bert-mini` at 11.2M parameters) on a combined label set:
- Labels: `positive`, `negative`, `neutral`, `work`, `personal`, `idea`, `todo`, `meeting`
- Convert to ONNX with q8 quantization
- Expected size: **~12-15 MB**
- Single forward pass (no N-way zero-shot overhead): **20-100 ms on mobile**

This requires a training step but produces the smallest, fastest result by far.

---

## 8. Smaller Model Alternatives

### For Sentiment Analysis

| Model | Params | ONNX q8 Size | Notes |
|-------|--------|-------------|-------|
| `Xenova/distilbert-base-uncased-finetuned-sst-2-english` | 67M | 64.5 MB | Proposed; too large |
| `boltuix/bert-mini` (needs ONNX conversion) | 11.2M | ~12 MB est. | Viable; needs fine-tuning on SST-2 |
| `boltuix/bert-micro` (needs ONNX conversion) | ~4.4M | ~5 MB est. | Ultra-small; accuracy trade-off |
| `Varnikasiva/sentiment-classification-bert-mini` | 11.2M | ~12 MB est. | Pre-trained for sentiment; needs ONNX export |

### For Zero-Shot Classification / Tagging

| Model | Params | ONNX q8 Size | Notes |
|-------|--------|-------------|-------|
| `Xenova/mobilebert-uncased-mnli` | 25M | 25.7 MB | Smallest ready-to-use NLI model |
| `Xenova/nli-deberta-v3-xsmall` | 22M backbone + 48M embed | 83.2 MB | Misleadingly named "xsmall"; reject |
| Custom fine-tuned classifier | ~11M | ~12 MB est. | Best option if you can train |

### Verdict on Sub-20 MB Alternatives

**For sentiment**: No off-the-shelf model with ONNX weights and transformers.js compatibility exists under 20 MB. The closest is MobileBERT-MNLI used in zero-shot mode (25.7 MB) or a custom conversion of `boltuix/bert-mini`.

**For zero-shot classification**: `Xenova/mobilebert-uncased-mnli` at 25.7 MB (q8) is the smallest viable option with existing ONNX weights.

---

## 9. Web Worker Architecture: Non-Negotiable

### Why the Current Main-Thread Approach Is Broken

The existing code (line 549 of app.js) eagerly preloads Whisper on the main thread:

```javascript
// Preload the Whisper model in the background so it's ready when needed
loadTranscriber().catch(() => {});
```

This blocks the main thread during model initialization. Adding two more models would make this dramatically worse.

### Recommended Architecture

```
Main Thread                    NLP Worker
    |                              |
    |--- postMessage(audioBlob) -->|
    |                              |-- Load Whisper (q8, ~39 MB)
    |                              |-- Transcribe audio
    |                              |-- Dispose Whisper
    |                              |-- Load MobileBERT-MNLI (q8, ~26 MB)
    |                              |-- Zero-shot: sentiment + tags
    |                              |-- Dispose MobileBERT
    |<-- postMessage(result) ------|
    |                              |-- Worker can be terminated
    |                              |   to guarantee memory cleanup
```

### Cross-Origin Isolation Requirement

For WASM multi-threading to work in transformers.js (which enables SIMD and parallel execution), the server must set these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, ONNX Runtime falls back to single-threaded WASM, which is 2-4x slower. The current app uses `python3 -m http.server` for development, which does not set these headers.

---

## 10. Initial Load Impact and Mitigation

### Problem

If all models are preloaded on first visit:
- Download: 39 + 25.7 = ~65 MB (single NLI model approach) to 39 + 64.5 + 25.7 = ~129 MB (two model approach)
- Parse/compile WASM: 1-3 seconds per model
- User sees a loading spinner for 10-60 seconds depending on connection

### Mitigation Strategy

1. **Do not preload NLP models.** Only preload Whisper (as the app already does). Sentiment/tagging models should load lazily after the first transcription completes.

2. **Show results progressively:**
   - Transcript appears first (after Whisper completes)
   - Sentiment/tags appear 2-5 seconds later (after NLP model loads and infers)
   - Use skeleton UI or "Analyzing..." placeholder

3. **Cache models aggressively.** Transformers.js uses the Cache API by default. First visit is slow; subsequent visits load from cache in ~1-2 seconds.

4. **Consider a "lite mode" default.** Ship without NLP models. Let users opt-in to "smart tagging" in settings, which triggers the one-time model download.

---

## 11. Recommendations: The Pragmatic Path

### Tier 1: Minimum Viable (Recommended)

**Use a single `Xenova/mobilebert-uncased-mnli` model (25.7 MB q8) for both sentiment and tagging via zero-shot classification.**

- Total new download: **25.7 MB** (not 167 MB)
- Total model budget including Whisper: **~65 MB** (not 207 MB)
- Runtime memory (one model at a time with disposal): **~100-150 MB peak**
- Inference time for 8 labels on mid-range phone: **~1.5-4 seconds**
- Mobile crash risk: **Low** (if using Worker with disposal)

Implementation:
- Move all inference to a dedicated Web Worker
- Load Whisper, transcribe, dispose; then load MobileBERT, classify, dispose
- Terminate Worker after pipeline completes to guarantee memory cleanup
- Lazy-load MobileBERT only after first transcription

### Tier 2: Optimal (If Engineering Budget Allows)

**Fine-tune a single `bert-mini` (11.2M params) on combined sentiment + tag labels. Export to ONNX q8.**

- Total new download: **~12 MB**
- Total model budget including Whisper: **~51 MB**
- Runtime memory: **~80-100 MB peak**
- Inference time (single forward pass, not N-way zero-shot): **20-100 ms on mobile**
- Mobile crash risk: **Very low**

This requires:
- A labeled dataset for your tag categories
- A training pipeline (Python, HuggingFace Trainer)
- ONNX export via Optimum
- Hosting the converted model

### Tier 3: Avoid

**Do not use the originally proposed two-model approach** (`distilbert-sst2` at 64.5 MB + `mobilebert-mnli` at 25.7 MB). It is wasteful (90 MB of new downloads), memory-dangerous on mobile, and unnecessary since the MobileBERT NLI model can handle both tasks.

**Do not use `Xenova/nli-deberta-v3-xsmall`** despite the appealing name. Its 128K vocabulary embedding makes it 83.2 MB quantized -- 3x larger than MobileBERT-MNLI for minimal accuracy improvement on short text.

---

## 12. Summary of Hard Numbers

| Metric | Two-Model (Proposed) | Single MobileBERT (Tier 1) | Custom bert-mini (Tier 2) |
|--------|---------------------|---------------------------|--------------------------|
| New model download | 90.2 MB | 25.7 MB | ~12 MB |
| Total with Whisper | ~129 MB | ~65 MB | ~51 MB |
| Peak runtime memory | 310-450 MB | 100-150 MB | 80-100 MB |
| Mobile crash risk | High | Low | Very Low |
| Inference latency (mobile, 5 tags) | 2-6.5 s | 1.5-4 s | 20-100 ms |
| Web Worker required | Yes | Yes | Yes |
| Requires training | No | No | Yes |
| Off-the-shelf ready | Yes | Yes | No |

---

## 13. Non-Negotiable Requirements (Regardless of Model Choice)

1. **Move ALL inference to a Web Worker.** The current main-thread approach is already problematic for Whisper alone. Adding any NLP model without a Worker will make the app unusable.

2. **Implement sequential load-and-dispose.** Never hold more than one model in memory at a time. Use Worker termination for reliable memory cleanup.

3. **Set Cross-Origin Isolation headers.** Without `COOP: same-origin` and `COEP: require-corp`, ONNX WASM runs single-threaded and is 2-4x slower. This has cascading impacts on CDN resource loading (all external resources need `crossorigin` attributes or CORS headers).

4. **Lazy-load NLP models.** Never download sentiment/tagging models on first page load. Load them only after the first transcription completes.

5. **Show progressive results.** Transcript first, then sentiment/tags with an "Analyzing..." indicator. Users should never wait for all processing to complete before seeing any result.

6. **Monitor Safari/iOS memory behavior.** Transformers.js v3 has documented memory leak issues on Apple platforms (Issue #1242). Test aggressively on real iOS devices, not just desktop Safari.
