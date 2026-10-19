FluidSynth - the synthesizer that plays the game music
=====================================================

libfluidsynth-3.dll (Windows) and fluidsynth.wasm / fluidsynth.js (browser) are FluidSynth
2.6.1, Copyright (C) 2000-2026 Peter Hanappe and others, distributed under the GNU Lesser
General Public License version 2.1 (LICENSE.txt in this folder).

Source code: https://github.com/FluidSynth/fluidsynth/archive/refs/tags/v2.6.1.tar.gz
             (https://github.com/FluidSynth/fluidsynth, tag v2.6.1), unmodified.

Built with: BUILD_SHARED_LIBS=ON osal=cpp11, static C runtime, all audio/MIDI drivers, network,
libsndfile, LADSPA, OpenMP, threads and native DLS off (the game only renders the synth's
output itself). The build recipe is in the remaster's CMakeLists.txt (Windows) and the
browser build's scripts (fluidsynth wasm module).

FluidSynth is a separate library: the game loads it at run time and works with any compatible
build of FluidSynth 2.x put in its place (Windows: replace libfluidsynth-3.dll; without it the
game falls back to its built-in TinySoundFont synth).

The soundfont (Music\midi\capone-gm.sf2) is GeneralUser GS v2.0.3 by S. Christian Collins,
cut down to the instruments the game music uses; its licence is in
Music\midi\LICENSE-GeneralUser-GS.txt.
