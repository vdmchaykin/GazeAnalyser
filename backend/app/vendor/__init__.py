"""Vendored eye-tracking pipeline.

Copied verbatim from the Gaze_estimation repository
(https://github.com/vdmchaykin/Gaze_estimation) at commit 3a84c2a, with only the
intra-package imports rewritten onto app.vendor so the modules import as a
normal package instead of through a sys.path injection.

Only what the backend actually calls is vendored: the pupil detector, the Neon
binary→CSV converter, and the HeatmapNet model plus its inference helper. The
rest of that repository (calibration_tool, gaze_mapping, downsample, training
code) stays upstream.

Upstream fixes have to be re-copied by hand — keep the commit above in sync.
"""
