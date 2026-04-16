Place trained SER artifacts in this directory to upgrade the backend from fallback routing to real model inference.

Expected layout:

- `wav2vec2/`
  Local Hugging Face style wav2vec2 checkpoint directory for embedding extraction.
- `feature_selectors/wav2vec_relieff_svm.json`
- `feature_selectors/wav2vec_nca_svm.json`
- `feature_selectors/handcrafted_nca_svm.json`
  Each file can be either a JSON array of selected feature names or a JSON object with a `feature_names` array.
- `classifiers/wav2vec_relieff_svm.joblib`
- `classifiers/wav2vec_nca_svm.joblib`
- `classifiers/handcrafted_nca_svm.joblib`
  Each file can be either a classifier object with `predict_proba()` or a dict containing:
  `model`, `feature_names`, and optional `labels`.

Without these artifacts, the backend still runs using the same staged architecture with fallback feature routes and majority voting.
