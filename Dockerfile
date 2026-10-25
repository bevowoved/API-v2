# syntax=docker/dockerfile:1
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:044d090d0c3ccfd30722126ebe46704885698970c8a303419dc0d704d628f0da AS src
FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/stubs ./scripts/stubs
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && apt-get update && apt-get install -y --no-install-recommends libjemalloc2 binutils && rm -rf /var/lib/apt/lists/*
COPY . .
COPY --from=src /nodejs/bin/node /tmp/node.full
COPY --from=src /usr/lib/x86_64-linux-gnu /tmp/libs
COPY --from=src /etc/ssl/certs/ca-certificates.crt /tmp/ca-certificates.crt
COPY --from=src /etc/passwd /etc/group /etc/nsswitch.conf /tmp/etc/
RUN npm run build \
 && E="node_modules/.bin/esbuild --bundle --platform=node --format=cjs --target=node26 --minify --charset=ascii --legal-comments=none --log-level=warning" \
 && $E src/index.ts --outfile=bundle/index.cjs --external:@firecrawl/pdf-inspector --external:@fastify/swagger-ui --external:./sentry-sdk \
 && $E src/utils/sentry-sdk.ts --outfile=bundle/sentry-sdk.js \
 && grep -q 'require("./sentry-sdk")' bundle/index.cjs \
 && node -e "require('./bundle/sentry-sdk.js').init;require('fastify');console.log('build sanity ok')" \
 && rm -rf /stage && mkdir -p /stage/debug /stage/root/nodejs/bin /stage/root/usr/lib/x86_64-linux-gnu /stage/root/tmp \
 && split() { strip --only-keep-debug "$1" -o "/stage/debug/$3" && strip --strip-all "$1" -o "$2" && objcopy --add-gnu-debuglink="/stage/debug/$3" "$2"; } \
 && P=/app/node_modules/@firecrawl/pdf-inspector-linux-x64-gnu/pdf-inspector.linux-x64-gnu.node \
 && split "$P" "$P" pdf-inspector.linux-x64-gnu.node.dbg && split /tmp/node.full /stage/root/nodejs/bin/node node.dbg \
 && node -e 'const fs=require("fs"),z=require("zlib"),names=[...fs.readFileSync("src/index.ts","utf8").match(/DOCS_FILES = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((m)=>m[1]),p="node_modules/@fastify/swagger-ui/static/",o="/stage/payload/app/dist/docs/";fs.mkdirSync(o,{recursive:true});for(const n of names)fs.writeFileSync(o+n+".br",z.brotliCompressSync(fs.readFileSync(p+n),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11,[z.constants.BROTLI_PARAM_MODE]:z.constants.BROTLI_MODE_TEXT}}));fs.writeFileSync(o+"v",JSON.parse(fs.readFileSync(p+"../package.json","utf8")).version)' \
 && install -D /app/package.json /stage/payload/app/package.json \
 && mkdir -p /stage/payload/app/node_modules/@firecrawl/pdf-inspector /stage/payload/app/node_modules/@firecrawl/pdf-inspector-linux-x64-gnu && cp /app/node_modules/@firecrawl/pdf-inspector/index.js /app/node_modules/@firecrawl/pdf-inspector/package.json /stage/payload/app/node_modules/@firecrawl/pdf-inspector/ && cp /app/node_modules/@firecrawl/pdf-inspector-linux-x64-gnu/package.json "$P" /stage/payload/app/node_modules/@firecrawl/pdf-inspector-linux-x64-gnu/ && rm "$P" && NAPI_RS_NATIVE_LIBRARY_PATH=/stage/payload/app/node_modules/@firecrawl/pdf-inspector-linux-x64-gnu/pdf-inspector.linux-x64-gnu.node node -e "const m = require('@firecrawl/pdf-inspector'); if (typeof m.extractTextWithPositionsAsync !== 'function') throw Error('loader check failed: native addon did not load from NAPI_RS_NATIVE_LIBRARY_PATH')" \
 && install -D /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 /stage/payload/app/lib/libjemalloc.so.2 \
 && install -D /app/bundle/index.cjs /stage/bundle/dist/index.js && cp /app/bundle/sentry-sdk.js /stage/bundle/dist/sentry-sdk.js \
 && install -D /tmp/ca-certificates.crt /stage/root/etc/ssl/certs/ca-certificates.crt && cp /tmp/etc/passwd /tmp/etc/group /tmp/etc/nsswitch.conf /stage/root/etc/ \
 && install -D /tmp/libs/ld-linux-x86-64.so.2 /stage/root/lib64/ld-linux-x86-64.so.2 \
 && cp /tmp/libs/libc.so.6 /tmp/libs/libm.so.6 /tmp/libs/libgcc_s.so.1 /tmp/libs/libpthread.so.0 /tmp/libs/libdl.so.2 /tmp/libs/librt.so.1 /tmp/libs/libnss_dns.so.2 /tmp/libs/libnss_files.so.2 /tmp/libs/libnss_compat.so.2 /tmp/libs/libresolv.so.2 /stage/root/usr/lib/x86_64-linux-gnu/ \
 && cp /tmp/libs/libstdc++.so.6.0.33 /stage/root/usr/lib/x86_64-linux-gnu/libstdc++.so.6 && cp /tmp/libs/libatomic.so.1.2.0 /stage/root/usr/lib/x86_64-linux-gnu/libatomic.so.1 \
 && chmod 1777 /stage/root/tmp && find /stage -exec touch -h -d @1700000000 {} +

FROM scratch AS debug
COPY --from=build /stage/debug /debug

FROM scratch
WORKDIR /app
COPY --from=build /stage/root/ /
COPY --from=build /stage/payload/app /app
COPY --from=build /stage/bundle/dist /app/dist
ENV NODE_ENV=production LD_PRELOAD=/app/lib/libjemalloc.so.2 MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0,narenas:1,background_thread:true NAPI_RS_NATIVE_LIBRARY_PATH=/app/node_modules/@firecrawl/pdf-inspector-linux-x64-gnu/pdf-inspector.linux-x64-gnu.node UV_THREADPOOL_SIZE=2 PORT=8080 HOST=0.0.0.0
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["--max-old-space-size=176", "--max-semi-space-size=2", "--v8-pool-size=1", "dist/index.js"]
