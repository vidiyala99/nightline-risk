import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

export interface PickedAsset {
  uri: string;
  name: string;
  type: string;
}

const FALLBACK_TYPE = 'application/octet-stream';

async function fromPhotoLibrary(): Promise<PickedAsset | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsEditing: false,
    quality: 0.85,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.fileName ?? 'evidence',
    type: asset.mimeType ?? FALLBACK_TYPE,
  };
}

async function fromFiles(): Promise<PickedAsset | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name ?? 'evidence',
    type: asset.mimeType ?? FALLBACK_TYPE,
  };
}

/**
 * Prompt the user to attach compliance evidence from either the photo/video
 * library or the Files app (which surfaces iCloud, Drive, on-device documents,
 * PDFs, etc.). Resolves to a normalized asset, or null if the user cancels.
 */
export function pickEvidence(): Promise<PickedAsset | null> {
  return new Promise((resolve) => {
    Alert.alert(
      'Add evidence',
      'Choose where to attach from.',
      [
        {
          text: 'Photo & Video Library',
          onPress: () => fromPhotoLibrary().then(resolve).catch(() => resolve(null)),
        },
        {
          text: 'Files / Drive',
          onPress: () => fromFiles().then(resolve).catch(() => resolve(null)),
        },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
