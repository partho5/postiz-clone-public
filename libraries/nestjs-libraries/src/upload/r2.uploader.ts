import {
  UploadPartCommand,
  S3Client,
  ListPartsCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { mediaUrl } from '@gitroom/helpers/utils/media.base.url';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

const ALLOWED_EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
};

// Multipart uploads go through the normalizer, so they may also carry
// QuickTime, which it turns into an mp4; simple uploads never do
export function multipartExtToMime(): Record<string, string> {
  return {
    ...ALLOWED_EXT_TO_MIME,
    ...(UploadFactory.processorEnabled() ? { '.mov': 'video/quicktime' } : {}),
  };
}

// The one type the speech audio of a caption job may be (ai.video-captions): a WAV. Its own map, passed to
// `normalizeExtension` and `checkUploadedObjectType`, so a web or video upload never accepts a .wav.
export const TRANSCRIPT_AUDIO_EXT_TO_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
};

// The one type the small video of an AI edit job may be (ai.video-editing): an mp4 the phone made, read by the
// perception model. Its own map, like the caption audio's.
export const EDIT_PROXY_EXT_TO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
};

// The image types a poster may be (api.media-retention, RET-B4), by the content's own magic bytes: a
// poster comes with no declared type, and the object is stored with the type found here.
const POSTER_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

// The extension (`.jpg`, `.png`, `.webp`) and type of a poster image, or null when the bytes are another type.
export async function posterType(
  data: Buffer
): Promise<{ ext: string; mime: string } | null> {
  const detected = await fileTypeFromBuffer(data);
  const ext = detected ? POSTER_MIME_TO_EXT[detected.mime] : undefined;
  return ext ? { ext, mime: detected.mime } : null;
}

// The lower-case extension of the file when `extToMime` (the web and video types unless another map is
// given) allows it, else null.
export function normalizeExtension(
  filename: string,
  extToMime: Record<string, string> = multipartExtToMime()
): string | null {
  const ext = path.extname(filename || '').toLowerCase();
  return extToMime[ext] ? ext : null;
}

const {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ACCESS_KEY,
  CLOUDFLARE_SECRET_ACCESS_KEY,
  CLOUDFLARE_BUCKETNAME,
} = process.env;

// The one R2 client of the system's multipart paths (the web routes below and the phone's direct
// upload). WHEN_REQUIRED, as in CloudflareStorage: otherwise a presigned UploadPart URL carries the
// CRC32 of its empty body in the query string.
export const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: CLOUDFLARE_ACCESS_KEY!,
    secretAccessKey: CLOUDFLARE_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

export const R2_BUCKET = CLOUDFLARE_BUCKETNAME!;

// Function to generate a random string
function generateRandomString() {
  return makeId(20);
}

export default async function handleR2Upload(
  endpoint: string,
  req: Request,
  res: Response
) {
  switch (endpoint) {
    case 'create-multipart-upload':
      return createMultipartUpload(req, res);
    case 'prepare-upload-parts':
      return prepareUploadParts(req, res);
    case 'complete-multipart-upload':
      return completeMultipartUpload(req, res);
    case 'list-parts':
      return listParts(req, res);
    case 'abort-multipart-upload':
      return abortMultipartUpload(req, res);
    case 'sign-part':
      return signPart(req, res);
  }
  return res.status(404).end();
}

export async function simpleUpload(
  data: Buffer,
  originalFilename: string,
  _contentType: string
) {
  const detected = await fileTypeFromBuffer(data);
  if (!detected || !Object.values(ALLOWED_EXT_TO_MIME).includes(detected.mime)) {
    throw new Error('Unsupported file type.');
  }
  const fileExtension = `.${detected.ext}`;
  const safeContentType = detected.mime;
  const randomFilename = generateRandomString() + fileExtension;

  const params = {
    Bucket: CLOUDFLARE_BUCKETNAME,
    Key: randomFilename,
    Body: data,
    ContentType: safeContentType,
  };

  const command = new PutObjectCommand({ ...params });
  await R2.send(command);

  return mediaUrl(randomFilename);
}

export async function createMultipartUpload(req: Request, res: Response) {
  const { file, fileHash } = req.body;
  const safeExt = normalizeExtension(file?.name || '');
  if (!safeExt) {
    return res.status(400).json({ message: 'Unsupported file type.' });
  }
  const safeContentType = multipartExtToMime()[safeExt];
  const randomFilename = generateRandomString() + safeExt;

  try {
    const params = {
      Bucket: CLOUDFLARE_BUCKETNAME,
      Key: `${randomFilename}`,
      ContentType: safeContentType,
      Metadata: {
        'x-amz-meta-file-hash': fileHash,
      },
    };

    const command = new CreateMultipartUploadCommand({ ...params });
    const response = await R2.send(command);
    return res.status(200).json({
      uploadId: response.UploadId,
      key: response.Key,
    });
  } catch (err) {
    console.log('Error', err);
    return res.status(500).json({ source: { status: 500 } });
  }
}

export async function prepareUploadParts(req: Request, res: Response) {
  const { partData } = req.body;

  const parts = partData.parts;

  const response = {
    presignedUrls: {},
  };

  for (const part of parts) {
    try {
      const params = {
        Bucket: CLOUDFLARE_BUCKETNAME,
        Key: partData.key,
        PartNumber: part.number,
        UploadId: partData.uploadId,
      };
      const command = new UploadPartCommand({ ...params });
      const url = await getSignedUrl(R2, command, { expiresIn: 3600 });

      // @ts-ignore
      response.presignedUrls[part.number] = url;
    } catch (err) {
      console.log('Error', err);
      return res.status(500).json(err);
    }
  }

  return res.status(200).json(response);
}

export async function listParts(req: Request, res: Response) {
  const { key, uploadId } = req.body;

  try {
    const params = {
      Bucket: CLOUDFLARE_BUCKETNAME,
      Key: key,
      UploadId: uploadId,
    };
    const command = new ListPartsCommand({ ...params });
    const response = await R2.send(command);

    return res.status(200).json(response['Parts']);
  } catch (err) {
    console.log('Error', err);
    return res.status(500).json(err);
  }
}

// Reads the head of a finished object and checks it is what its key's extension says. The caller
// deletes the object on anything but 'ok': the web routes and the phone's direct upload both do.
// 'unsupported' is an extension that is not allowed, 'mismatch' contents that are not the type. The
// allowed types are the web and video ones unless `extToMime` names another map (the caption audio's).
export async function checkUploadedObjectType(
  key: string,
  extToMime: Record<string, string> = multipartExtToMime()
): Promise<'ok' | 'unsupported' | 'mismatch'> {
  const safeExt = normalizeExtension(key || '', extToMime);
  if (!safeExt) {
    return 'unsupported';
  }
  const expectedMime = extToMime[safeExt];

  const head = await R2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Range: 'bytes=0-4100',
    })
  );
  const chunks: Buffer[] = [];
  // @ts-ignore
  for await (const chunk of head.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const prefix = Buffer.concat(chunks);
  const detected = await fileTypeFromBuffer(prefix);

  // .mov and .mp4 are the same ISO BMFF family: a .mov with an ISO brand
  // sniffs as video/mp4 and a QuickTime-brand file is often named .mp4.
  // The normalizer reads both and always writes an mp4, so accept both
  // for either extension whenever it is on; without it .mp4 stays strict.
  const acceptedMimes =
    UploadFactory.processorEnabled() &&
    (safeExt === '.mov' || safeExt === '.mp4')
      ? ['video/quicktime', 'video/mp4']
      : [expectedMime];
  if (!detected || !acceptedMimes.includes(detected.mime)) {
    return 'mismatch';
  }
  return 'ok';
}

// Reads one object whole by its key, for a small one (an AI edit's proxy piece, at most 16 MiB); an empty key is
// refused. Throws when the object is not there.
export async function readObject(key: string): Promise<Buffer> {
  if (!key) {
    throw new Error('No object key to read');
  }
  const res = await R2.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key })
  );
  const chunks: Buffer[] = [];
  // @ts-ignore
  for await (const chunk of res.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Deletes one object by its key, never a prefix or a list; an empty key is refused (it would not name an
// object) and an object already gone is fine, so a repeat of a delete is safe. The caption audio's sweep and
// its job use it (ai.video-captions).
export async function deleteObject(key: string) {
  if (!key) {
    throw new Error('No object key to delete');
  }
  try {
    await R2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    const e = err as {
      name?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const gone =
      ['NotFound', 'NoSuchKey'].includes(e?.name || '') ||
      ['NotFound', 'NoSuchKey'].includes(e?.Code || '') ||
      e?.$metadata?.httpStatusCode === 404;
    if (!gone) {
      throw err;
    }
  }
}

export async function completeMultipartUpload(req: Request, res: Response) {
  const { key, uploadId, parts } = req.body;

  try {
    const command = new CompleteMultipartUploadCommand({
      Bucket: CLOUDFLARE_BUCKETNAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });
    const response = await R2.send(command);

    const type = await checkUploadedObjectType(key);
    if (type === 'unsupported') {
      await R2.send(
        new DeleteObjectCommand({ Bucket: CLOUDFLARE_BUCKETNAME, Key: key })
      );
      return res.status(400).json({ message: 'Unsupported file type.' });
    }
    if (type === 'mismatch') {
      await R2.send(
        new DeleteObjectCommand({ Bucket: CLOUDFLARE_BUCKETNAME, Key: key })
      );
      return res
        .status(400)
        .json({ message: 'File contents do not match declared type.' });
    }

    response.Location = mediaUrl(response?.Location?.split('/').at(-1)!);
    return response;
  } catch (err) {
    console.log('Error', err);
    return res.status(500).json(err);
  }
}

export async function abortMultipartUpload(req: Request, res: Response) {
  const { key, uploadId } = req.body;

  try {
    const params = {
      Bucket: CLOUDFLARE_BUCKETNAME,
      Key: key,
      UploadId: uploadId,
    };
    const command = new AbortMultipartUploadCommand({ ...params });
    const response = await R2.send(command);

    return res.status(200).json(response);
  } catch (err) {
    console.log('Error', err);
    return res.status(500).json(err);
  }
}

export async function signPart(req: Request, res: Response) {
  const { key, uploadId } = req.body;
  const partNumber = parseInt(req.body.partNumber);

  const params = {
    Bucket: CLOUDFLARE_BUCKETNAME,
    Key: key,
    PartNumber: partNumber,
    UploadId: uploadId,
    Expires: 3600,
  };

  const command = new UploadPartCommand({ ...params });
  const url = await getSignedUrl(R2, command, { expiresIn: 3600 });

  return res.status(200).json({
    url: url,
  });
}
