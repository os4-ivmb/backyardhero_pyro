/**
 * Extract YouTube video ID from various YouTube URL formats
 * Supports:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - https://youtube.com/embed/VIDEO_ID
 * - https://www.youtube.com/v/VIDEO_ID
 * - https://youtube.com/v/VIDEO_ID
 * - https://m.youtube.com/watch?v=VIDEO_ID
 * - https://youtube.com/shorts/VIDEO_ID
 * - https://www.youtube.com/watch?v=VIDEO_ID&list=...&t=123s
 * 
 * @param {string} url - YouTube URL in any format
 * @returns {string|null} - Video ID or null if not found
 */
export function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Trim whitespace
  url = url.trim();

  // If already in youtu.be format, extract directly
  const youtuBeMatch = url.match(/(?:youtu\.be\/)([^?&#\n]+)/);
  if (youtuBeMatch && youtuBeMatch[1]) {
    return youtuBeMatch[1];
  }

  // youtube.com/watch?v=VIDEO_ID or youtube.com/watch?.*v=VIDEO_ID
  const watchMatch = url.match(/(?:youtube\.com\/watch\?)(?:.*&)?v=([^&?#\n]+)/);
  if (watchMatch && watchMatch[1]) {
    return watchMatch[1];
  }

  // youtube.com/embed/VIDEO_ID
  const embedMatch = url.match(/(?:youtube\.com\/embed\/)([^?&#\n]+)/);
  if (embedMatch && embedMatch[1]) {
    return embedMatch[1];
  }

  // youtube.com/v/VIDEO_ID
  const vMatch = url.match(/(?:youtube\.com\/v\/)([^?&#\n]+)/);
  if (vMatch && vMatch[1]) {
    return vMatch[1];
  }

  // youtube.com/shorts/VIDEO_ID
  const shortsMatch = url.match(/(?:youtube\.com\/shorts\/)([^?&#\n]+)/);
  if (shortsMatch && shortsMatch[1]) {
    return shortsMatch[1];
  }

  // If it's just a video ID (11 characters, alphanumeric, dashes, underscores)
  const videoIdPattern = /^[a-zA-Z0-9_-]{11}$/;
  if (videoIdPattern.test(url)) {
    return url;
  }

  return null;
}

/**
 * Normalize YouTube URL to https://youtu.be/VIDEO_ID format
 * @param {string} url - YouTube URL in any format
 * @returns {string|null} - Normalized URL or null if invalid
 */
export function normalizeYouTubeUrl(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }
  return `https://youtu.be/${videoId}`;
}

