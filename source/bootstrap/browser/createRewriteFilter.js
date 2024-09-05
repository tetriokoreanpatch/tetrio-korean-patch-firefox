/**
 * @param {string} name
 * @param {string} url
 * @param {Object} options
 * @param {Function<DataSource, Filter, boolean>} options.enabledFor
 * @param {Function<DataSource, Request, Filter, string?>} options.onStart
 * @param {Function<DataSource, Request, Filter, string?>} options.onStop
 */


async function domainDataStatus(urlString) {

  let { useContentPack } = new URL(decodeURI(urlString))
    .search
    .slice(1)
    .split('&')
    .map(e => e.split('='))
    .reduce((obj, [key, value]) => {
      obj[key] = value;
      return obj;
    }, {})

  if (!useContentPack)
    return { ok: false, reason: 'URL does not specify a content pack' };

  if (!allowURLPackLoader)
    return { ok: false, reason: 'URL pack loading is disabled' };

  let url = new URL(decodeURIComponent(useContentPack));

  if (whitelistedLoaderDomains.indexOf(url.origin) == -1)
    return { ok: false, reason: 'Domain ' + url.origin + ' not whitelisted' };

  return { ok: true, url: url };
}

const REQUEST_CACHE = {};
async function getDataForDomain(urlString) {
  try {
    let { ok, reason, url } = await domainDataStatus(urlString);

    if (!ok) {
      console.log(reason);
      return null;
    }

    if (!REQUEST_CACHE[url]) {
      REQUEST_CACHE[url] = (async () => {
        let req = await fetch(url, { mode: 'cors' });
        let unsanitizedData = await req.json();

        let sanitizedData = {};
        let result = await sanitizeAndLoadTPSE(unsanitizedData, {
          async set(pairs) {
            Object.assign(sanitizedData, pairs);
          }
        });
        sanitizedData.tetrioPlusEnabled = true;

        console.log("Loaded content pack from " + url + ". Result:\n" + result);
        return sanitizedData;
      })().catch(ex => {
        console.error(ex);
        return null;
      });

      // Empty cache after 10 minutes. This should be enough time to load
      // the page and then play a few games (since music isn't fetched until
      // its played). We don't want to store it for too long though - content
      // packs can become absolutely positively downright enourmous.
      setTimeout(() => {
        delete REQUEST_CACHE[url];
        console.log("Cleared cached request for", url)
      }, 10 * 60 * 1000);
    }

    return await REQUEST_CACHE[url];
  } catch(ex) {
    console.error(ex);
    return null;
  }
}

async function getDataSourceForDomain(urlString) {
  let data = await getDataForDomain(urlString);
  if (data) {
    return {
      async get(keys) {
        // Prevent infinite loops in some users that don't expect
        // the promise to resolve syncronously
        await new Promise(r => setTimeout(r));
        return data; // It's technically complient
      }
    }
  } else {
    return browser.storage.local;
  }
}



function createRewriteFilter(name, url, options) {
  browser.webRequest.onBeforeRequest.addListener(
    async request => {
      if (new URL(request.url).searchParams.get('bypass-tetrio-plus') != null) {
        console.log(`[${name} filter] Ignoring bypassed ${url}`);
        return;
      }

      let origin = request.originUrl || request.url;
      console.log("Request origin URL", origin);
      const dataSource = await getDataSourceForDomain(origin);
      
      if (options.enabledFor) {
        let enabled = await options.enabledFor(dataSource, request.url);
        if (!enabled) {
          console.log(`[${name} filter] Disabled, ignoring ${url}`);
          return;
        }
      }

      if (options.blockRequest) {
        request.cancel = true;
        console.log(`[${name} filter] Request to ${url} blocked`);
        return;
      }

      console.log(`[${name} filter] Filtering ${url}`);

      if (options.onStart || options.onStop) {
        let filter = browser.webRequest.filterResponseData(request.requestId);
        let decoder = new TextDecoder("utf-8");
        function callback({ type, data, encoding }) {
          switch(encoding || 'text') {
            case 'base64-data-url':
              filter.write(convertDataURIToBinary(data));
              break;
            case 'text':
              filter.write(new TextEncoder().encode(data));
              break;
            default:
              throw new Error('Unknown encoding');
          }
        }

        if (options.onStart) {
          filter.onstart = async evt => {
            await options.onStart(dataSource, request.url, null, callback);
            // Close the filter now if there's no onStop handler to close it.
            if (!options.onStop)
              filter.close();
          }
        }

        // Potential future BUG: We're assuming onStop will only be called
        // with textual data, but in the future we might want to process binary
        // data in transit.
        let originalData = [];
        filter.ondata = event => {
          let str = decoder.decode(event.data, { stream: true });
          originalData.push(str);
        }

        if (options.onStop) {
          filter.onstop = async evt => {
            await options.onStop(dataSource, request.url, originalData.join(''), callback);
            filter.close();
          }
        }
      }
    },
    { urls: [url] },
    ["blocking"]
  )
}

// https://gist.github.com/borismus/1032746
var BASE64_MARKER = ';base64,';
function convertDataURIToBinary(dataURI) {
  var base64Index = dataURI.indexOf(BASE64_MARKER) + BASE64_MARKER.length;
  var base64 = dataURI.substring(base64Index);
  var raw = atob(base64);
  var rawLength = raw.length;
  var array = new Uint8Array(new ArrayBuffer(rawLength));

  for(i = 0; i < rawLength; i++) {
    array[i] = raw.charCodeAt(i);
  }
  return array;
}
