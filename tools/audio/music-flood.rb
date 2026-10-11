# DAM BREAK flood theme: "Here it comes". 80 bpm, a 64-beat loop played twice;
# the tick and one-beat lead are slicing markers (see music-title.rb). Plays
# from the moment the water is released until the level is decided.
#
# The build theme's sibling, not a stranger: same tempo, same key, same 3 s
# bar, so the cut across happens on the bar and the plucked line seems to carry on.
# What changes is the floor under it — the chords turn to B minor, the bass
# drives in eighths, low toms gallop 3+3+2, strings swell, and at the end of
# each 32 beats a noise swell leans into the next downbeat. Tense, not scary:
# this is for seven-year-olds watching their own dam.
use_bpm 80
use_random_seed 33
sample :elec_tick, amp: 1.4
sleep 1
chords = [chord(:b2, :minor), chord(:g2, :major), chord(:d3, :major), chord(:a2, :major),
          chord(:b2, :minor), chord(:g2, :major), chord(:e2, :minor), chord(:fs2, :major)]
in_thread do
  with_fx :lpf, cutoff: 80 do
    use_synth :bass_foundation
    2.times do
      chords.each do |c|
        r = c[0] - 12
        16.times do |k|
          play (k % 4 == 3 ? r + 12 : r), amp: (k % 2 == 0 ? 0.38 : 0.27), release: 0.22
          sleep 0.5
        end
      end
    end
  end
end
in_thread do
  gallop = [1, 0, 0, 1, 0, 0, 1, 0]
  2.times do
    32.times do
      8.times do |k|
        sample :drum_tom_lo_hard, amp: (k == 0 ? 0.26 : 0.18), rate: 0.85, lpf: 90 if gallop[k] == 1
        sleep 0.25
      end
    end
  end
end
in_thread do
  2.times do
    64.times do
      sample :drum_cymbal_closed, amp: 0.08, rate: 1.3
      sleep 0.5
      sample :drum_cymbal_closed, amp: 0.13, rate: 1.4
      sleep 0.5
    end
  end
end
in_thread do
  2.times do
    chords.each do
      sample :bd_boom, amp: 0.55
      sleep 8
    end
  end
end
in_thread do
  with_fx :reverb, room: 0.8, mix: 0.45 do
    use_synth :blade
    2.times do
      chords.each_with_index do |c, i|
        lift = i >= 4 ? 12 : 0
        play c.map { |n| n + 12 + lift }, attack: 1.5, sustain: 4.5, release: 2, amp: 0.45, vibrato_depth: 0.12
        sleep 8
      end
    end
  end
end
in_thread do
  with_fx :reverb, room: 0.6, mix: 0.3 do
    use_synth :pluck
    shape = [0, 2, 1, 3, 2, 1, 3, 2]
    2.times do
      chords.each do |c|
        tones = [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24]
        16.times do |k|
          play tones[shape[k % 8]], amp: (k % 4 == 0 ? 0.75 : 0.5), pan: rrand(-0.35, 0.35)
          sleep 0.5
        end
      end
    end
  end
end
# The lean into each half's downbeat: four beats of rising noise.
in_thread do
  2.times do
    2.times do
      sleep 28
      with_fx :lpf, cutoff: 60, cutoff_slide: 4 do |f|
        control f, cutoff: 100
        use_synth :bnoise
        play 60, attack: 3.6, sustain: 0, release: 0.4, amp: 0.22
        sleep 4
      end
    end
  end
end
