# Speech Emotion Recognition: Research Notes and App Implementation

This file documents the research direction for adding **audio-based emotion detection** to `deaf-meet`, and the practical implementation path used in this repo.

## Why Audio Emotion Detection

Text-only emotion tagging misses part of the signal that Deaf and Hard-of-Hearing users often care about most:

- intensity
- urgency
- hesitation
- calmness
- excitement

In speech emotion recognition (SER), those cues are often carried by **prosody** and **voice quality**, not just by the words themselves.

## Relevant Research

### 1. Handcrafted acoustic features remain useful

The GeMAPS / eGeMAPS line of work was created specifically for voice and affective computing. It emphasizes compact, interpretable acoustic features such as:

- pitch / fundamental frequency
- loudness / energy
- spectral balance
- jitter and shimmer
- formant-related descriptors
- voiced / unvoiced behavior

Source:

- Eyben et al., *The Geneva Minimalistic Acoustic Parameter Set (GeMAPS) for Voice Research and Affective Computing* (IEEE TAC, 2015)  
  https://sail.usc.edu/publications/html/b2hd-Eyben2015TheGenevaminimalisticacoustic.html

### 2. Self-supervised speech representations are strong for SER

More recent SER work shows that pretrained speech models such as `wav2vec 2.0` can perform very well when transferred to emotion tasks.

Source:

- Pepino, Riera, Ferrer, *Emotion Recognition from Speech Using Wav2vec 2.0 Embeddings* (Interspeech 2021, arXiv:2104.03502)  
  https://arxiv.org/abs/2104.03502

### 3. Best results often come from feature fusion

Recent work shows that **deep audio representations + handcrafted acoustic features** can outperform either source alone. That is especially relevant for this project because it suggests we should not think of “classical audio features” and “modern learned features” as competing ideas.

Source:

- Eriş, Akbal, *Enhancing Speech Emotion Recognition through Deep Learning and Handcrafted Feature Fusion* (Applied Acoustics, 2024)  
  https://doi.org/10.1016/j.apacoust.2024.110070

### 4. SER in practice is still a robustness problem

Recent reviews consistently point out that real-world SER depends on:

- feature quality
- dataset mismatch
- noise robustness
- cross-speaker variability
- fusion strategy

That matters here because an Electron overlay running from a laptop microphone is a much noisier setting than acted benchmark datasets.

Source:

- *Speech emotion recognition approaches: A systematic review* (Speech Communication, 2023)  
  https://doi.org/10.1016/j.specom.2023.102974

## What The Research Means For This App

For this repo, there are really **two implementation levels**:

### Level 1: Browser-safe prosodic SER

This is the version we can implement directly inside Electron / Chrome with no extra ML runtime.

Use lightweight audio cues that map well to emotion research:

- RMS loudness -> intensity / arousal
- interruption timing -> urgency / turn pressure
- pitch estimate -> vocal height
- pitch range -> expressiveness / activation
- voiced ratio -> how steadily voiced the recent segment is

This is not a full academic SER model, but it is aligned with the literature because it uses the same broad family of **prosodic acoustic correlates**.

### Level 2: Full local SER model

This is the stronger research-grade next step.

Recommended architecture:

1. Audio chunking at 16 kHz
2. `openSMILE` eGeMAPS or ComparE features
3. `wav2vec2` embeddings
4. A lightweight classifier head or ensemble
5. Fusion with text emotion and timing cues

That design is the closest match to the 2024 fusion paper and would likely need a local Python service or native addon rather than pure browser JavaScript.

## What Is Implemented In This Repo Now

The current implementation adds **audio-informed emotion fusion**, not just a visual meter.

### Audio features extracted in the capture layer

In `renderer/control.html` and `renderer/speech-capture.html`, the app now estimates:

- `samples`: recent loudness contour
- `volume`: average recent loudness
- `pitchHz`: current pitch estimate from autocorrelation
- `pitchMean`: average recent pitch
- `pitchRange`: normalized recent pitch spread
- `voicedRatio`: fraction of recent frames with usable pitch
- `interruption`: turn pressure signal already used by the overlay

### Emotion logic in the main process

In `main.js`, the app now:

1. Keeps the existing text-based emotion path
2. Computes an **audio arousal proxy** from:
   - loudness
   - interruption
   - pitch range
   - average pitch
   - voiced ratio
3. Uses a heuristic audio-emotion decision layer:
   - high arousal + urgency/interruption -> `angry`
   - high arousal + positive / celebratory cues -> `excited`
   - moderate arousal + positive cues -> `happy`
   - low energy + low pitch variation -> `sad`
   - stable low-interruption speech -> `calm`
4. Fuses audio and text predictions into one final overlay emotion

### Why this is a reasonable v1

This implementation is intentionally simpler than a research paper pipeline, but it follows the research in the right order:

- start with prosodic cues that are known to matter
- keep features interpretable
- fuse modalities instead of replacing one with another
- leave room for a stronger local model later

## Current Heuristic Design

The current audio path behaves more like an **arousal-aware prosody model** than a full discrete-emotion classifier.

Approximate interpretation:

- `volume` + `pitchRange` + `pitchMean` + `interruption` -> arousal
- text keywords help resolve valence
- final label is chosen by **fusion**, not by audio alone

That means:

- audio can push `happy` toward `excited`
- audio can override weak text-neutral output when urgency is clearly audible
- calm / sad cues can still come through when loudness and pitch movement drop

## Current Limitations

- Pitch estimation is lightweight and browser-side, not studio-grade F0 tracking
- The model is heuristic, not trained end-to-end
- Noise, echo, and laptop microphones can distort prosodic measurements
- We are not yet using:
  - MFCCs
  - spectral tilt
  - jitter / shimmer
  - formants
  - wav2vec2 embeddings
  - eGeMAPS via openSMILE

## Recommended Next Implementation Step

If we want to move from heuristic audio emotion to a stronger SER system, the next step should be:

1. Record short rolling audio windows, for example 1.5 to 3 seconds
2. Send them to a local Python SER service
3. Extract:
   - eGeMAPS or ComparE features with `openSMILE`
   - `wav2vec2` embeddings
4. Train or fine-tune a compact classifier on a common emotion label set
5. Return:
   - discrete emotion
   - arousal / valence
   - confidence
6. Fuse that with transcript text and interruption timing in `main.js`

## Suggested Label Strategy For This App

The overlay currently uses:

- `happy`
- `sad`
- `angry`
- `calm`
- `excited`
- `neutral`

For a future trained model, it will be easier to support this overlay if the backend predicts:

- discrete label
- arousal score
- valence score
- confidence

Then map into the overlay labels:

- high arousal + positive valence -> `excited`
- medium arousal + positive valence -> `happy`
- high arousal + negative valence -> `angry`
- low arousal + negative valence -> `sad`
- low arousal + positive/neutral valence -> `calm`
- low-confidence center region -> `neutral`

## Summary

Research suggests the best SER systems usually combine:

- strong speech representations
- interpretable acoustic features
- robust fusion

This repo now implements the **first practical audio SER stage**:

- live prosodic feature extraction in the browser
- audio-informed emotion heuristics
- fusion with text emotion detection

That gives us a realistic bridge from the current overlay prototype to a future full local SER pipeline.
