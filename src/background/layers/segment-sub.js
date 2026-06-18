// Redirects /stitched-ad/ segments to a silent blank .ts file.
// Logic moved to rules.json (DNR) for Manifest V3 compatibility.

const SegmentSub = {
  init() {
    // In MV3, the actual redirection is handled by the browser via rules.json.
    // We use this init only for logging or tracking purposes.
    console.log('[TTV] Segment substitution ready (Managed by DNR)');
  }
};
