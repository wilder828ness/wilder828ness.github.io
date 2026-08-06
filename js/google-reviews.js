/* google-reviews.js — live Google Business reviews for Nubz Toys.
 *
 * Pulls your ACTUAL Google reviews (not copy-paste) via the Google Maps
 * JavaScript API's Places library and renders them into any element with
 * id="google-reviews" or id="google-reviews-home". Safe to deploy before it's
 * configured: if apiKey or placeId is blank, it does nothing and shows nothing.
 *
 * ── HOW TO TURN IT ON (Google Cloud Console) ──────────────────────────────
 *  1. Cloud Console → create a new project (e.g. "Nubz Toys Web").
 *  2. APIs & Services → Enable APIs → enable "Maps JavaScript API"
 *     (that's the one that carries the Places library used here).
 *  3. Credentials → Create credentials → API key.
 *  4. Restrict the key:
 *       • Application restrictions → "Websites" (HTTP referrers) →
 *         add   https://nubztoys.com/*   and   https://www.nubztoys.com/*
 *       • API restrictions → restrict to "Maps JavaScript API".
 *     (Referrer-restricted keys are safe to ship in client code — that's how
 *      Google Maps keys are meant to be used.)
 *  5. Get your Place ID: https://developers.google.com/maps/documentation/places/web-service/place-id
 *     (search your business; copy the Place ID string, looks like "ChIJ...").
 *  6. Billing must be enabled on the project, but the free monthly credit
 *     covers far more than a small store will ever use.
 *  7. Paste both values below, commit, deploy. Done.
 *
 * Notes / honest limits: Google returns up to 5 reviews and you cannot choose
 * which (it's their selection, usually "most relevant"). Attribution to Google
 * is included as required.
 */
(function () {
  var GOOGLE_REVIEWS_CONFIG = {
    apiKey:     '',   // <-- paste your Maps JavaScript API key
    placeId:    '',   // <-- paste your Google Business Place ID (ChIJ...)
    maxReviews: 6,    // Google caps this near 5 regardless
    minRating:  4     // only show reviews at/above this star rating
  };

  function mounts() {
    return ['google-reviews', 'google-reviews-home']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
  }

  // Nothing to do if unconfigured or no mount on this page — stay invisible.
  if (!GOOGLE_REVIEWS_CONFIG.apiKey || !GOOGLE_REVIEWS_CONFIG.placeId) return;
  document.addEventListener('DOMContentLoaded', function () {
    if (!mounts().length) return;
    loadMaps(render);
  });

  function loadMaps(cb) {
    if (window.google && window.google.maps && window.google.maps.places) return cb();
    window.__nubzReviewsInit = cb;
    var s = document.createElement('script');
    s.async = true; s.defer = true;
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' +
      encodeURIComponent(GOOGLE_REVIEWS_CONFIG.apiKey) +
      '&libraries=places&callback=__nubzReviewsInit';
    document.head.appendChild(s);
  }

  function stars(n) {
    n = Math.round(n || 0);
    return '<span class="text-amber-400" aria-label="' + n + ' out of 5">' +
      '★★★★★'.slice(0, n) + '<span class="text-slate-600">' + '☆☆☆☆☆'.slice(0, 5 - n) + '</span></span>';
  }
  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render() {
    var svc = new google.maps.places.PlacesService(document.createElement('div'));
    svc.getDetails({
      placeId: GOOGLE_REVIEWS_CONFIG.placeId,
      fields: ['name', 'rating', 'user_ratings_total', 'reviews', 'url']
    }, function (place, status) {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !place) return;
      var reviews = (place.reviews || [])
        .filter(function (r) { return (r.rating || 0) >= GOOGLE_REVIEWS_CONFIG.minRating; })
        .slice(0, GOOGLE_REVIEWS_CONFIG.maxReviews);
      if (!reviews.length) return;

      var head =
        '<div class="text-center mb-6">' +
          '<div class="text-xs uppercase tracking-[2px] text-cyan-400 font-semibold mb-2">REVIEWS</div>' +
          '<div class="text-2xl font-bold text-white">' + (place.rating || '') + ' ' + stars(place.rating) + '</div>' +
          '<a href="' + esc(place.url || '#') + '" target="_blank" rel="noopener noreferrer" class="text-sm text-slate-400 hover:text-white">' +
            (place.user_ratings_total || reviews.length) + ' Google reviews →</a>' +
        '</div>';

      var cards = reviews.map(function (r) {
        return '<div class="bg-slate-900 border border-slate-800 rounded-3xl p-6">' +
          '<div class="flex items-center gap-x-3 mb-3">' +
            (r.profile_photo_url ? '<img src="' + esc(r.profile_photo_url) + '" alt="" class="w-8 h-8 rounded-full" referrerpolicy="no-referrer">' : '') +
            '<div><div class="text-slate-200 text-sm font-semibold">' + esc(r.author_name) + '</div>' +
            '<div class="text-xs">' + stars(r.rating) + ' <span class="text-slate-500">' + esc(r.relative_time_description || '') + '</span></div></div>' +
          '</div>' +
          '<p class="text-slate-300 text-sm leading-relaxed">' + esc(r.text) + '</p>' +
        '</div>';
      }).join('');

      var html = head +
        '<div class="grid md:grid-cols-2 gap-6">' + cards + '</div>' +
        '<p class="text-center text-[11px] text-slate-600 mt-4">Reviews sourced live from Google.</p>';

      mounts().forEach(function (el) { el.innerHTML = html; });
    });
  }
})();
