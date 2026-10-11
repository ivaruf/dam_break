# Fast water striking the dam: a short slap of spray and a few droplets.
# The game picks its playback rate per hit, so a wave of them never sounds
# like one sample on repeat.
use_random_seed 9
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 3.5 do
  with_fx :reverb, room: 0.4, mix: 0.2 do
    sample :drum_tom_lo_soft, rate: 0.6, amp: 0.3, lpf: 70
    with_fx :hpf, cutoff: 70 do
      with_fx :lpf, cutoff: 112 do
        use_synth :noise
        play 60, attack: 0.004, decay: 0.08, sustain_level: 0.35, release: 0.4, amp: 0.6
      end
    end
    use_synth :sine
    6.times do
      n = rrand(84, 96)
      s = play n, attack: 0.001, release: 0.04, amp: rrand(0.04, 0.1), note_slide: 0.03
      control s, note: n + 7
      sleep rrand(0.04, 0.09)
    end
  end
end
