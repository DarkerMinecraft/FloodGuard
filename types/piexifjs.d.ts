// Minimal types for the parts of piexifjs we use (the package ships none).
declare module "piexifjs" {
  type IfdData = Record<number, unknown>;
  export type ExifObject = { "0th"?: IfdData; Exif?: IfdData; GPS?: IfdData; Interop?: IfdData; "1st"?: IfdData };
  export function dump(exif: ExifObject): string;
  /** Inserts an EXIF binary string into a JPEG given as a data URL or binary string. */
  export function insert(exifBytes: string, jpeg: string): string;
  export function load(jpeg: string): ExifObject;
  export const ImageIFD: Record<string, number>;
  export const ExifIFD: Record<string, number>;
  export const GPSIFD: Record<string, number>;
  export const GPSHelper: {
    degToDmsRational(deg: number): [number, number][];
    dmsRationalToDeg(dms: [number, number][], ref: string): number;
  };
  const piexif: {
    dump: typeof dump;
    insert: typeof insert;
    load: typeof load;
    ImageIFD: typeof ImageIFD;
    ExifIFD: typeof ExifIFD;
    GPSIFD: typeof GPSIFD;
    GPSHelper: typeof GPSHelper;
  };
  export default piexif;
}
