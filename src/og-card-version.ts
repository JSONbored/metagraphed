// Constants only: storage and discovery must not import rendering dependencies.
export const CARD_VERSION = "5";
export const OG_IMAGE_LEGACY_FILE_NAME = "og-image.png";
export const OG_IMAGE_FILE_NAME = `og-image-v${CARD_VERSION}.png`;
export const OG_IMAGE_ARTIFACT_PATH = `/metagraph/${OG_IMAGE_FILE_NAME}`;
export const OG_IMAGE_FILE_NAMES: readonly string[] = [
  OG_IMAGE_LEGACY_FILE_NAME,
  OG_IMAGE_FILE_NAME,
];
