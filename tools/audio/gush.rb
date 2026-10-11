# Water forcing through a gap or spilling over the crest: a rushing pour that
# swells in and eases off over about a second and a half.
use_random_seed 6
# Level trim: balances this cue against the rest of the set, which share one gain.
with_fx :level, amp: 1.25 do
  with_fx :reverb, room: 0.5, mix: 0.25 do
    in_thread do
      with_fx :bpf, centre: 86, res: 0.3 do
        use_synth :bnoise
        play 60, attack: 0.25, sustain: 0.55, release: 0.8, amp: 1.0
      end
    end
    in_thread do
      with_fx :lpf, cutoff: 68 do
        use_synth :bnoise
        play 60, attack: 0.3, sustain: 0.45, release: 0.8, amp: 0.7
      end
    end
    with_fx :hpf, cutoff: 80 do
      use_synth :cnoise
      18.times do
        play 60, attack: 0.002, release: rrand(0.01, 0.04), cutoff: rrand(95, 118), res: 0.6, amp: rrand(0.05, 0.16)
        sleep rrand(0.03, 0.08)
      end
    end
  end
end
