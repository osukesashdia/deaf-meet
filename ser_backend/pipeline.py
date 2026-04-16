import json
import math
import os
from collections import Counter
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

try:
    import joblib
except Exception:  # pragma: no cover - optional dependency
    joblib = None

try:
    import numpy as np
except Exception:  # pragma: no cover - optional dependency
    np = None

ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
CLASSIFIER_DIR = ARTIFACT_DIR / "classifiers"
SELECTOR_DIR = ARTIFACT_DIR / "feature_selectors"
WAV2VEC_DIR = ARTIFACT_DIR / "wav2vec2"
DEFAULT_WAV2VEC_MODEL = os.getenv("SER_WAV2VEC_MODEL", "facebook/wav2vec2-base")
ALLOW_WAV2VEC_DOWNLOAD = os.getenv("SER_WAV2VEC_ALLOW_DOWNLOAD", "0") == "1"
ENABLE_WAV2VEC = os.getenv("SER_ENABLE_WAV2VEC", "0") == "1"
ENABLE_OPENSMILE = os.getenv("SER_ENABLE_OPENSMILE", "0") == "1"
EMOTIONS = ("angry", "excited", "happy", "calm", "sad", "neutral")


def clamp(value, min_value, max_value):
    return max(min_value, min(max_value, value))


def safe_mean(values):
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def safe_std(values):
    if len(values) < 2:
        return 0.0
    mean_value = safe_mean(values)
    variance = sum((value - mean_value) ** 2 for value in values) / len(values)
    return math.sqrt(variance)


def normalize_waveform(waveform):
    normalized = []
    for value in waveform or []:
        try:
            normalized.append(clamp(float(value), -1.0, 1.0))
        except (TypeError, ValueError):
            continue
    return normalized


def resample_waveform(waveform, from_rate, to_rate):
    waveform = normalize_waveform(waveform)
    if not waveform or from_rate <= 0 or to_rate <= 0 or from_rate == to_rate:
        return waveform
    if np is None:
        return waveform

    source = np.asarray(waveform, dtype=np.float32)
    target_length = max(1, int(len(source) * (float(to_rate) / float(from_rate))))
    source_index = np.linspace(0.0, 1.0, num=len(source), dtype=np.float32)
    target_index = np.linspace(0.0, 1.0, num=target_length, dtype=np.float32)
    return np.interp(target_index, source_index, source).astype(np.float32).tolist()


def compress_vector(values, chunks=24):
    if not values:
        return [0.0] * chunks
    if np is None:
        values = list(values)
        step = max(1, len(values) // chunks)
        compressed = []
        for index in range(0, len(values), step):
            window = values[index : index + step]
            compressed.append(safe_mean(window))
            if len(compressed) >= chunks:
                break
        while len(compressed) < chunks:
            compressed.append(0.0)
        return compressed[:chunks]

    vector = np.asarray(values, dtype=np.float32).flatten()
    chunk_size = max(1, int(math.ceil(len(vector) / float(chunks))))
    compressed = []
    for start in range(0, len(vector), chunk_size):
        window = vector[start : start + chunk_size]
        compressed.append(float(window.mean()))
        if len(compressed) >= chunks:
            break
    while len(compressed) < chunks:
        compressed.append(0.0)
    return compressed[:chunks]


def to_feature_map(values, prefix):
    return {f"{prefix}_{index}": float(value) for index, value in enumerate(values or [])}


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_transformer_stack():
    try:
        import torch
        from transformers import AutoFeatureExtractor, Wav2Vec2Model

        return torch, AutoFeatureExtractor, Wav2Vec2Model
    except Exception:
        return None, None, None


def load_opensmile_module():
    try:
        import opensmile

        return opensmile
    except Exception:
        return None


class Wav2VecFeatureExtractor:
    def __init__(self):
        self.model = None
        self.feature_extractor = None
        self.source = "proxy-wav2vec"
        self.load_error = None
        self._attempted = False
        self.output_dim = 24

    def _load_backend(self):
        if self._attempted:
            return

        self._attempted = True
        if not ENABLE_WAV2VEC and not WAV2VEC_DIR.exists():
            self.load_error = "wav2vec-disabled"
            return
        torch, auto_feature_extractor, wav2vec2_model = load_transformer_stack()
        if torch is None or auto_feature_extractor is None or wav2vec2_model is None:
            self.load_error = "missing-transformers"
            return

        local_source = str(WAV2VEC_DIR) if WAV2VEC_DIR.exists() else None
        remote_source = DEFAULT_WAV2VEC_MODEL
        candidates = []
        if local_source:
            candidates.append((local_source, True, "local-wav2vec2"))
        if ALLOW_WAV2VEC_DOWNLOAD:
            candidates.append((remote_source, False, remote_source))

        for source, local_only, source_name in candidates:
            try:
                self.feature_extractor = auto_feature_extractor.from_pretrained(
                    source,
                    local_files_only=local_only,
                )
                self.model = wav2vec2_model.from_pretrained(
                    source,
                    local_files_only=local_only,
                )
                self.model.eval()
                self.source = source_name
                self.load_error = None
                return
            except Exception as error:
                self.load_error = str(error)

    def _extract_real(self, waveform, sample_rate):
        if self.model is None or self.feature_extractor is None:
            return None

        torch, _, _ = load_transformer_stack()
        if torch is None:
            return None

        target_rate = int(getattr(self.feature_extractor, "sampling_rate", 16000) or 16000)
        processed_waveform = resample_waveform(waveform, sample_rate, target_rate)
        if not processed_waveform:
            return {
                "vector": [0.0] * self.output_dim,
                "source": self.source,
            }

        inputs = self.feature_extractor(
            processed_waveform,
            sampling_rate=target_rate,
            return_tensors="pt",
            padding=True,
        )

        with torch.no_grad():
            hidden = self.model(**inputs).last_hidden_state
            pooled = hidden.mean(dim=1).squeeze(0).detach().cpu().numpy()

        return {
            "vector": compress_vector(pooled, chunks=self.output_dim),
            "source": self.source,
        }

    def _extract_proxy(self, waveform, sample_rate):
        if not waveform:
            return {
                "vector": [0.0] * self.output_dim,
                "source": "proxy-empty",
            }

        stride = max(1, len(waveform) // 12)
        bands = []
        for start in range(0, len(waveform), stride):
            window = waveform[start : start + stride]
            if not window:
                continue
            bands.extend(
                [
                    safe_mean(window),
                    safe_mean([abs(value) for value in window]),
                ]
            )

        derivative = [
            abs(waveform[index] - waveform[index - 1])
            for index in range(1, len(waveform))
        ]
        embedding = bands[:20]
        embedding.extend(
            [
                safe_mean([abs(value) for value in waveform]),
                safe_std(waveform),
                safe_mean(derivative),
                clamp(sample_rate / 48000.0, 0.0, 1.0),
            ]
        )
        while len(embedding) < self.output_dim:
            embedding.append(0.0)
        return {
            "vector": embedding[: self.output_dim],
            "source": "proxy-wav2vec",
        }

    def extract(self, waveform, sample_rate):
        self._load_backend()
        real_output = self._extract_real(waveform, sample_rate)
        if real_output:
            return real_output
        return self._extract_proxy(waveform, sample_rate)


class HandcraftedFeatureExtractor:
    def __init__(self):
        self.source = "manual-prosody"
        self.smile = None
        self.load_error = None
        self._attempted = False

    def _load_smile(self):
        if self._attempted:
            return

        self._attempted = True
        if not ENABLE_OPENSMILE:
            self.load_error = "opensmile-disabled"
            return
        opensmile = load_opensmile_module()
        if opensmile is None:
            self.load_error = "missing-opensmile"
            return

        try:
            self.smile = opensmile.Smile(
                feature_set=opensmile.FeatureSet.eGeMAPSv02,
                feature_level=opensmile.FeatureLevel.Functionals,
            )
            self.source = "opensmile-egemapsv02"
            self.load_error = None
        except Exception as error:
            self.load_error = str(error)

    def _extract_manual(self, waveform, prosody, volume, interruption):
        if not waveform:
            return {
                "rms_mean": volume,
                "rms_std": 0.0,
                "zero_crossing_rate": 0.0,
                "peak_amplitude": 0.0,
                "crest_factor": 0.0,
                "energy_slope": 0.0,
                "pitch_mean_norm": 0.0,
                "pitch_range": clamp(prosody.get("pitchRange", 0.0), 0.0, 1.0),
                "voiced_ratio": clamp(prosody.get("voicedRatio", 0.0), 0.0, 1.0),
                "interruption": interruption,
                "volume": volume,
            }

        abs_values = [abs(value) for value in waveform]
        rms_mean = math.sqrt(safe_mean([value * value for value in waveform]))
        zero_crossings = sum(
            1
            for index in range(1, len(waveform))
            if (waveform[index - 1] <= 0 < waveform[index])
            or (waveform[index - 1] >= 0 > waveform[index])
        )
        midpoint = max(1, len(abs_values) // 2)
        energy_slope = safe_mean(abs_values[midpoint:]) - safe_mean(abs_values[:midpoint])
        pitch_mean = float(prosody.get("pitchMean", 0.0) or 0.0)

        return {
            "rms_mean": clamp(rms_mean, 0.0, 1.0),
            "rms_std": clamp(safe_std(abs_values), 0.0, 1.0),
            "zero_crossing_rate": clamp(zero_crossings / max(1, len(waveform)), 0.0, 1.0),
            "peak_amplitude": clamp(max(abs_values), 0.0, 1.0),
            "crest_factor": clamp(max(abs_values) / (rms_mean + 1e-6), 0.0, 10.0),
            "energy_slope": clamp((energy_slope + 1.0) / 2.0, 0.0, 1.0),
            "pitch_mean_norm": clamp((pitch_mean - 100.0) / 180.0, 0.0, 1.0),
            "pitch_range": clamp(prosody.get("pitchRange", 0.0), 0.0, 1.0),
            "voiced_ratio": clamp(prosody.get("voicedRatio", 0.0), 0.0, 1.0),
            "interruption": clamp(interruption, 0.0, 1.0),
            "volume": clamp(volume, 0.0, 1.0),
        }

    def extract(self, waveform, sample_rate, prosody, volume, interruption):
        self._load_smile()
        manual_features = self._extract_manual(waveform, prosody, volume, interruption)
        if self.smile is None or np is None:
            return {
                "features": manual_features,
                "source": self.source,
            }

        try:
            processed_waveform = resample_waveform(waveform, sample_rate, 16000)
            signal = np.asarray(processed_waveform, dtype=np.float32)
            if signal.size == 0:
                return {
                    "features": manual_features,
                    "source": self.source,
                }

            frame = self.smile.process_signal(signal, sampling_rate=16000)
            smile_features = {}
            if hasattr(frame, "to_dict"):
                raw = frame.iloc[0].to_dict() if len(frame.index) else {}
                for key, value in raw.items():
                    try:
                        smile_features[f"egemaps_{key}"] = float(value)
                    except (TypeError, ValueError):
                        continue

            merged = {
                **manual_features,
                **smile_features,
            }
            return {
                "features": merged,
                "source": self.source,
            }
        except Exception:
            return {
                "features": manual_features,
                "source": "manual-prosody",
            }


class FeatureSelector:
    DEFAULT_SELECTED = {
        "wav2vec_relieff_svm": [
            "wv_abs_mean",
            "wv_delta_mean",
            "volume",
            "interruption",
            "pitch_range",
        ],
        "wav2vec_nca_svm": [
            "wv_0",
            "wv_5",
            "pitch_mean_norm",
            "voiced_ratio",
            "volume",
        ],
        "handcrafted_nca_svm": [
            "rms_mean",
            "rms_std",
            "pitch_range",
            "voiced_ratio",
            "interruption",
        ],
    }

    def __init__(self):
        self.routes = {}
        self.source = "default-static"
        self._load_routes()

    def _load_routes(self):
        if not SELECTOR_DIR.exists() or joblib is None:
            self.routes = dict(self.DEFAULT_SELECTED)
            return

        loaded_routes = {}
        for route_name in self.DEFAULT_SELECTED:
            json_path = SELECTOR_DIR / f"{route_name}.json"
            joblib_path = SELECTOR_DIR / f"{route_name}.joblib"

            route_features = None
            if json_path.exists():
                payload = load_json(json_path)
                if isinstance(payload, dict):
                    route_features = payload.get("feature_names")
                elif isinstance(payload, list):
                    route_features = payload
            elif joblib_path.exists():
                try:
                    payload = joblib.load(joblib_path)
                    if isinstance(payload, dict):
                        route_features = payload.get("feature_names")
                    elif hasattr(payload, "get_support") and hasattr(payload, "feature_names_in_"):
                        support = payload.get_support()
                        route_features = [
                            name
                            for name, keep in zip(payload.feature_names_in_, support)
                            if keep
                        ]
                except Exception:
                    route_features = None

            if route_features:
                loaded_routes[route_name] = list(route_features)

        self.routes = {
            **self.DEFAULT_SELECTED,
            **loaded_routes,
        }
        if loaded_routes:
            self.source = "artifact-selectors"

    def select(self, combined_features):
        return {
            route: {name: combined_features.get(name, 0.0) for name in feature_names}
            for route, feature_names in self.routes.items()
        }


class ClassicalClassifierEnsemble:
    def __init__(self):
        self.route_weights = {
            "wav2vec_relieff_svm": {
                "angry": {"volume": 0.35, "interruption": 0.35, "pitch_range": 0.18, "wv_abs_mean": 0.12},
                "excited": {"volume": 0.28, "pitch_range": 0.28, "wv_delta_mean": 0.2, "interruption": 0.08},
                "happy": {"volume": 0.18, "pitch_range": 0.16, "wv_abs_mean": 0.08},
                "calm": {"pitch_range": -0.22, "interruption": -0.18, "volume": -0.12},
                "sad": {"volume": -0.24, "pitch_range": -0.18, "wv_abs_mean": -0.08},
                "neutral": {},
            },
            "wav2vec_nca_svm": {
                "angry": {"volume": 0.28, "pitch_mean_norm": 0.08, "wv_0": 0.16, "interruption": 0.26},
                "excited": {"pitch_mean_norm": 0.24, "wv_5": 0.18, "volume": 0.16},
                "happy": {"pitch_mean_norm": 0.14, "voiced_ratio": 0.08, "volume": 0.1},
                "calm": {"voiced_ratio": 0.18, "interruption": -0.16, "volume": -0.08},
                "sad": {"volume": -0.18, "pitch_mean_norm": -0.12, "voiced_ratio": 0.06},
                "neutral": {},
            },
            "handcrafted_nca_svm": {
                "angry": {"rms_mean": 0.32, "interruption": 0.3, "pitch_range": 0.18, "rms_std": 0.12},
                "excited": {"rms_mean": 0.2, "pitch_range": 0.28, "voiced_ratio": 0.1},
                "happy": {"rms_mean": 0.14, "pitch_range": 0.16, "voiced_ratio": 0.08},
                "calm": {"voiced_ratio": 0.22, "interruption": -0.14, "pitch_range": -0.16},
                "sad": {"rms_mean": -0.22, "pitch_range": -0.18, "rms_std": -0.1},
                "neutral": {},
            },
        }
        self.models = {}
        self.source = "fallback-weights"
        self._load_models()

    def _load_models(self):
        if not CLASSIFIER_DIR.exists() or joblib is None:
            return

        loaded = {}
        for route_name in self.route_weights:
            path = CLASSIFIER_DIR / f"{route_name}.joblib"
            if not path.exists():
                continue
            try:
                payload = joblib.load(path)
                loaded[route_name] = payload
            except Exception:
                continue

        if loaded:
            self.models = loaded
            self.source = "artifact-classifiers"

    def _predict_with_artifact(self, route_name, selected_features):
        payload = self.models.get(route_name)
        if payload is None or np is None:
            return None

        feature_names = None
        model = payload
        label_names = None

        if isinstance(payload, dict):
            model = payload.get("model")
            feature_names = payload.get("feature_names")
            label_names = payload.get("labels")

        if model is None:
            return None

        ordered_names = feature_names or list(selected_features.keys())
        vector = np.asarray(
            [[float(selected_features.get(name, 0.0)) for name in ordered_names]],
            dtype=np.float32,
        )

        try:
            probabilities = None
            if hasattr(model, "predict_proba"):
                probabilities = model.predict_proba(vector)[0]
                classes = list(getattr(model, "classes_", []) or label_names or [])
            else:
                decision = model.decision_function(vector)
                decision = np.asarray(decision).reshape(-1)
                if decision.size == 0:
                    return None
                shifted = np.exp(decision - decision.max())
                probabilities = shifted / shifted.sum()
                classes = list(getattr(model, "classes_", []) or label_names or [])

            if not classes:
                classes = list(label_names or EMOTIONS[: len(probabilities)])

            raw_scores = {
                str(label): float(probability)
                for label, probability in zip(classes, probabilities)
            }
            best_emotion = max(raw_scores, key=raw_scores.get)
            return {
                "route": route_name,
                "emotion": best_emotion,
                "score": clamp(float(raw_scores[best_emotion]), 0.0, 1.0),
                "raw_scores": raw_scores,
            }
        except Exception:
            return None

    def _predict_with_weights(self, route_name, selected_features):
        emotion_scores = {}
        for emotion, weights in self.route_weights[route_name].items():
            score = 0.0
            for feature_name, weight in weights.items():
                score += selected_features.get(feature_name, 0.0) * weight
            emotion_scores[emotion] = score

        best_emotion = max(emotion_scores, key=emotion_scores.get)
        best_score = emotion_scores[best_emotion]
        ordered_scores = sorted(emotion_scores.values(), reverse=True)
        margin = best_score - ordered_scores[1] if len(ordered_scores) > 1 else best_score

        return {
            "route": route_name,
            "emotion": best_emotion,
            "score": clamp(0.5 + margin, 0.0, 1.0),
            "raw_scores": emotion_scores,
        }

    def predict(self, selected_feature_sets):
        predictions = []
        for route_name, features in selected_feature_sets.items():
            artifact_prediction = self._predict_with_artifact(route_name, features)
            predictions.append(
                artifact_prediction or self._predict_with_weights(route_name, features)
            )
        return predictions


class MajorityVotingEnsemble:
    def vote(self, predictions):
        votes = Counter(prediction["emotion"] for prediction in predictions)
        winning_vote_count = max(votes.values())
        tied = [emotion for emotion, count in votes.items() if count == winning_vote_count]

        if len(tied) == 1:
            emotion = tied[0]
        else:
            emotion = max(
                tied,
                key=lambda label: safe_mean(
                    prediction["score"]
                    for prediction in predictions
                    if prediction["emotion"] == label
                ),
            )

        confidence = safe_mean(
            prediction["score"]
            for prediction in predictions
            if prediction["emotion"] == emotion
        )

        return {
            "label": emotion,
            "emotion": emotion,
            "source": "audio-ser-ensemble",
            "score": confidence,
            "votes": dict(votes),
            "winningRoutes": [
                prediction["route"]
                for prediction in predictions
                if prediction["emotion"] == emotion
            ],
        }


class AudioSERPipeline:
    def __init__(self):
        self.wav2vec = Wav2VecFeatureExtractor()
        self.handcrafted = HandcraftedFeatureExtractor()
        self.selector = FeatureSelector()
        self.classifiers = ClassicalClassifierEnsemble()
        self.ensemble = MajorityVotingEnsemble()

    def describe(self):
        return {
            "wav2vecSource": self.wav2vec.source,
            "wav2vecError": self.wav2vec.load_error,
            "handcraftedSource": self.handcrafted.source,
            "handcraftedError": getattr(self.handcrafted, "load_error", None),
            "selectorSource": self.selector.source,
            "classifierSource": self.classifiers.source,
            "artifactDir": str(ARTIFACT_DIR),
        }

    def infer(self, waveform, sample_rate, prosody, volume, interruption):
        normalized_waveform = normalize_waveform(waveform)
        wav2vec_output = self.wav2vec.extract(normalized_waveform, sample_rate)
        handcrafted_output = self.handcrafted.extract(
            normalized_waveform,
            sample_rate,
            prosody,
            volume,
            interruption,
        )

        embedding = wav2vec_output["vector"]
        combined_features = {
            "volume": clamp(volume, 0.0, 1.0),
            "interruption": clamp(interruption, 0.0, 1.0),
            "pitch_range": clamp(prosody.get("pitchRange", 0.0), 0.0, 1.0),
            "pitch_mean_norm": clamp(
                (float(prosody.get("pitchMean", 0.0) or 0.0) - 100.0) / 180.0,
                0.0,
                1.0,
            ),
            "voiced_ratio": clamp(prosody.get("voicedRatio", 0.0), 0.0, 1.0),
            "wv_abs_mean": safe_mean([abs(value) for value in embedding[:8]]),
            "wv_delta_mean": safe_mean(
                [abs(embedding[index] - embedding[index - 1]) for index in range(1, len(embedding))]
            ),
            **to_feature_map(embedding, "wv"),
            **handcrafted_output["features"],
        }

        selected = self.selector.select(combined_features)
        predictions = self.classifiers.predict(selected)
        result = self.ensemble.vote(predictions)

        return {
            **result,
            "pipeline": {
                "wav2vecSource": wav2vec_output["source"],
                "handcraftedSource": handcrafted_output["source"],
                "selectorSource": self.selector.source,
                "classifierSource": self.classifiers.source,
                "selectedRoutes": list(selected.keys()),
                "classifierPredictions": predictions,
            },
        }
