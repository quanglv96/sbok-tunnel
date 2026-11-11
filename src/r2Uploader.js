'use strict';

const fs = require('fs');
const { withRetry } = require('./retry');

/** Đẩy MP3 lên R2, thử lại 3 lần có backoff (BR-10). Lỗi sau 3 lần -> ném lỗi, MP3 local vẫn giữ để thử lại. */
function createR2Uploader(r2, { client, makeCommand, log = console.log, backoffMs = 1000, wait } = {}) {
  let s3 = client;
  const command = makeCommand || ((params) => {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    return new PutObjectCommand(params);
  });
  async function getClient() {
    if (s3) return s3;
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: 'auto',
      endpoint: r2.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });
    return s3;
  }

  async function upload(key, filePath) {
    const c = await getClient();
    await withRetry(
      () => c.send(command({
        Bucket: r2.bucket,
        Key: key,
        Body: fs.readFileSync(filePath),
        ContentType: 'audio/mpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      })),
      {
        attempts: 3,
        backoffMs,
        wait,
        onError: (err, attempt) => log(`R2 upload ${key} lỗi lần ${attempt}/3: ${err.message}`),
      },
    );
  }

  return { upload };
}

module.exports = { createR2Uploader };
