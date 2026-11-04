/* Physical-media identity shared by the service worker (as an import), dashboard pages (script tag) and tests.
   One asset = one object on X's CDN, whatever URL spelling a code path produced. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultMediaAsset = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const stripName = value => {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      /* Preserve malformed evidence as an opaque identity. */
    }
    return decoded.replace(/:[a-z0-9_]+$/i, '').replace(/\.(jpe?g|png|webp|gif|mp4|webm|m4s|m3u8|mov)$/i, '');
  };

  function assetIdentity(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || ''));
    } catch {
      return { kind: 'unknown', asset: String(rawUrl || ''), host: '' };
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    const folder = segments[0] || '';
    if (host === 'pbs.twimg.com') {
      if (folder === 'media' && segments[1]) return { kind: 'image', asset: `img:${stripName(segments[1])}`, host };
      if (folder === 'tweet_video_thumb' && segments[1])
        return { kind: 'gif-thumb', asset: `gifthumb:${stripName(segments[1])}`, host };
      if (/_video_thumb$/.test(folder) && segments[1])
        return { kind: 'video-thumb', asset: `vidthumb:${segments[1]}`, host };
      if (folder === 'profile_images' || folder === 'profile_banners')
        return { kind: 'profile', asset: `${folder}:${segments.slice(1).map(stripName).join('/')}`, host };
      return {
        kind: 'image',
        asset: `${host}${url.pathname.replace(/:[a-z0-9_]+$/i, '').replace(/\.(jpe?g|png|webp|gif)$/i, '')}`,
        host,
      };
    }
    if (host === 'video.twimg.com') {
      if (folder === 'tweet_video' && segments[1]) return { kind: 'gif', asset: `gif:${stripName(segments[1])}`, host };
      if (['ext_tw_video', 'amplify_video', 'dm_video'].includes(folder) && segments[1])
        return { kind: 'video', asset: `vid:${segments[1]}`, host };
      return { kind: 'video', asset: `${host}${url.pathname}`, host };
    }
    url.hash = '';
    return { kind: 'other', asset: url.href, host };
  }

  const sameAsset = (a, b) => Boolean(a && b) && assetIdentity(a).asset === assetIdentity(b).asset;
  return Object.freeze({ assetIdentity, sameAsset });
});
