export interface ConnectorFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface StorageRecord {
  path: string;
  size_bytes: number;
  content_type: string;
  version: number;
}

export type ConnectorFileDownloader = (
  downloadUrl: string,
  maxBytes: number,
) => Promise<Response>;

/** A started part upload, as POST <multipart_url> returns it. */
export interface MultipartUploadSession {
  upload_id: string;
  size_bytes: number;
  part_size: number;
  part_count: number;
  parts_url: string;
  complete_url: string;
  abort_url: string;
  expires_at: string;
}
