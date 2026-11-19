import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

function patchMpegtsDemuxer(code: string): string | null {
  const initTarget =
    't.prototype.dispatchAudioInitSegment=function(e){var t={type:"audio"};if(t.id=this.audio_track_.id,t.timescale=1e3,t.duration=this.duration_,"aac"===this.audio_metadata_.codec){var i="aac"===e.codec?e.data:null,a=new Q(i);t.audioSampleRate=a.sampling_rate,t.channelCount=a.channel_count,t.codec=a.codec_mimetype,t.originalCodec=a.original_codec_mimetype,t.config=a.config,t.refSampleDuration=1024/t.audioSampleRate*t.timescale}else if("ac-3"===this.audio_metadata_.codec){var n="ac-3"===e.codec?e.data:null,o=new Ee(n);t.audioSampleRate=o.sampling_rate,t.channelCount=o.channel_count,t.codec=o.codec_mimetype,t.originalCodec=o.original_codec_mimetype,t.config=o.config,t.refSampleDuration=1536/t.audioSampleRate*t.timescale}else if("ec-3"===this.audio_metadata_.codec){var s="ec-3"===e.codec?e.data:null,d=new Re(s);t.audioSampleRate=d.sampling_rate,t.channelCount=d.channel_count,t.codec=d.codec_mimetype,t.originalCodec=d.original_codec_mimetype,t.config=d.config,t.refSampleDuration=256*d.num_blks/t.audioSampleRate*t.timescale}else"opus"===this.audio_metadata_.codec?(t.audioSampleRate=this.audio_metadata_.sample_rate,t.channelCount=this.audio_metadata_.channel_count,t.channelConfigCode=this.audio_metadata_.channel_config_code,t.codec="opus",t.originalCodec="opus",t.config=void 0,t.refSampleDuration=20):"mp3"===this.audio_metadata_.codec&&(t.audioSampleRate=this.audio_metadata_.sample_rate,t.channelCount=this.audio_metadata_.channel_count,t.codec="mp3",t.originalCodec="mp3",t.config=void 0);';

  const initReplacement =
    't.prototype.dispatchAudioInitSegment=function(e){if(!e)return;e.codec&&("aac"===e.codec&&e.data?this.audio_metadata_={codec:"aac",audio_object_type:e.data.audio_object_type,sampling_freq_index:e.data.sampling_freq_index,sampling_frequency:e.data.sampling_frequency,channel_config:e.data.channel_config}:"ac-3"===e.codec&&e.data?this.audio_metadata_={codec:"ac-3",sampling_frequency:e.data.sampling_frequency,bit_stream_identification:e.data.bit_stream_identification,bit_stream_mode:e.data.bit_stream_mode,low_frequency_effects_channel_on:e.data.low_frequency_effects_channel_on,channel_mode:e.data.channel_mode}:"ec-3"===e.codec&&e.data?this.audio_metadata_={codec:"ec-3",sampling_frequency:e.data.sampling_frequency,bit_stream_identification:e.data.bit_stream_identification,low_frequency_effects_channel_on:e.data.low_frequency_effects_channel_on,num_blks:e.data.num_blks,channel_mode:e.data.channel_mode}:"opus"===e.codec&&e.meta?this.audio_metadata_=e.meta:"mp3"===e.codec&&e.data&&(this.audio_metadata_={codec:"mp3",object_type:e.data.object_type,sample_rate:e.data.sample_rate,channel_count:e.data.channel_count}));if(!this.audio_metadata_)return;var t={type:"audio"};if(t.id=this.audio_track_.id,t.timescale=1e3,t.duration=this.duration_,"aac"===this.audio_metadata_.codec){var i="aac"===e.codec?e.data:null;if(!i)return;var a=new Q(i);t.audioSampleRate=a.sampling_rate,t.channelCount=a.channel_count,t.codec=a.codec_mimetype,t.originalCodec=a.original_codec_mimetype,t.config=a.config,t.refSampleDuration=1024/t.audioSampleRate*t.timescale}else if("ac-3"===this.audio_metadata_.codec){var n="ac-3"===e.codec?e.data:null;if(!n)return;var o=new Ee(n);t.audioSampleRate=o.sampling_rate,t.channelCount=o.channel_count,t.codec=o.codec_mimetype,t.originalCodec=o.original_codec_mimetype,t.config=o.config,t.refSampleDuration=1536/t.audioSampleRate*t.timescale}else if("ec-3"===this.audio_metadata_.codec){var s="ec-3"===e.codec?e.data:null;if(!s)return;var d=new Re(s);t.audioSampleRate=d.sampling_rate,t.channelCount=d.channel_count,t.codec=d.codec_mimetype,t.originalCodec=d.original_codec_mimetype,t.config=d.config,t.refSampleDuration=256*d.num_blks/t.audioSampleRate*t.timescale}else"opus"===this.audio_metadata_.codec?(t.audioSampleRate=this.audio_metadata_.sample_rate,t.channelCount=this.audio_metadata_.channel_count,t.channelConfigCode=this.audio_metadata_.channel_config_code,t.codec="opus",t.originalCodec="opus",t.config=void 0,t.refSampleDuration=20):"mp3"===this.audio_metadata_.codec&&(t.audioSampleRate=this.audio_metadata_.sample_rate,t.channelCount=this.audio_metadata_.channel_count,t.codec="mp3",t.originalCodec="mp3",t.config=void 0);';

  const mp3Target =
    't.prototype.parseMP3Payload=function(e,t){if(!this.has_video_||this.video_init_segment_dispatched_){var i=e[1]>>>3&3,a=(6&e[1])>>1,n=(e[2],(12&e[2])>>>2),r=3&~(e[3]>>>6)?2:1,o=0,s=34;switch(i){case 0:o=[11025,12e3,8e3,0][n];break;case 2:o=[22050,24e3,16e3,0][n];break;case 3:o=[44100,48e3,32e3,0][n]}';

  const mp3Replacement =
    't.prototype.parseMP3Payload=function(e,t){if(!e||e.byteLength<4)return;if(!this.has_video_||this.video_init_segment_dispatched_){var i=e[1]>>>3&3,a=(6&e[1])>>1,n=(e[2],(12&e[2])>>>2),r=3&~(e[3]>>>6)?2:1,o=0,s=34;switch(i){case 0:o=[11025,12e3,8e3,0][n];break;case 2:o=[22050,24e3,16e3,0][n];break;case 3:o=[44100,48e3,32e3,0][n]}if(!o)return;';

  let patched = code;
  let changed = false;
  if (patched.includes(initTarget)) {
    patched = patched.replace(initTarget, initReplacement);
    changed = true;
  }
  if (patched.includes(mp3Target)) {
    patched = patched.replace(mp3Target, mp3Replacement);
    changed = true;
  }
  return changed ? patched : null;
}

function patchMpegtsAudioDemuxerPlugin(): Plugin {
  return {
    name: 'patch-mpegts-audio-demuxer',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('mpegts.js/dist/mpegts.js')) {
        return null;
      }
      const patched = patchMpegtsDemuxer(code);
      return patched ? {code: patched, map: null} : null;
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      patchMpegtsAudioDemuxerPlugin(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'autoUpdate',
        includeAssets: [
          'favicon.ico',
          'apple-touch-icon.png',
          'icon.svg',
          'offline.html',
        ],
        manifest: {
          id: '/',
          name: 'CineBox — Movies, Series & Live TV',
          short_name: 'CineBox',
          description:
            'Cinema streaming hub for Movies, Series, Live TV, and Interactive EPG Guide.',
          theme_color: '#090B10',
          background_color: '#090B10',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    optimizeDeps: {
      rolldownOptions: {
        plugins: [patchMpegtsAudioDemuxerPlugin()],
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
