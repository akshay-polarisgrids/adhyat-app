const https = require('https');

const HOST = 'https://oshoworld.com';

function get(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'Mozilla/5.0 (adhyat player)' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, tries));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => (tries > 1 ? resolve(get(url, tries - 1)) : reject(err)));
  });
}

async function getJSON(url) {
  const { status, body } = await get(url);
  if (status !== 200) throw new Error(`${status} ${url}`);
  return JSON.parse(body);
}

// One discourse: its audio file plus which series (album) it belongs to. null if the slug is not a discourse.
async function fetchTrack(slug) {
  const data = await getJSON(`${HOST}/api/server/audio/detail/${encodeURIComponent(slug)}`);
  const a = data && data.audioData;
  if (!a || !a.audioFile || !a.series_slug) return null;
  return {
    series: { id: a.series_id, slug: a.series_slug, title: a.series_name, lang: a.language },
    track: { slug: a.slug, title: a.title, n: a.audio_index, dur: a.duration, file: a.audioFile, image: a.imageFile },
  };
}

module.exports = { HOST, get, getJSON, fetchTrack };
