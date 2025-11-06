export async function onRequest(context) {
  const sampleStore = context.env.SAMPLES;
  const responseData = {
    samples: [],
    repeaters:[],
    edges: []};

  const samplesList = await sampleStore.list();
  samplesList.keys.forEach(s => {
    responseData.samples.push({
      time: s.metadata.time,
      lat: s.metadata.lat,
      lon: s.metadata.lon,
      path: s.metadata.path,
    });
  });

  return new Response(JSON.stringify(responseData));
}
