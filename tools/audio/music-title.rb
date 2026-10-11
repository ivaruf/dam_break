# DAM BREAK title theme: "Morning in the valley". 60 bpm, a 32-beat loop
# played twice. Plays behind the title diorama and the level list.
#
# The opening tick is a slicing marker for encode.mjs: the loop begins exactly
# one beat after it, and the SECOND pass (which already carries the first
# pass's reverb tails) is what ships, so the seam is the piece's own decay
# wrapping round rather than a cut to silence.
#
# Same key as the build and flood themes (D major / B minor), so the crossfade
# from the menu into a level never passes through a clash.
use_bpm 60
use_random_seed 12
sample :elec_tick, amp: 1.4
sleep 1
prog = [chord(:d3, :major7), chord(:b2, :minor7), chord(:g2, :major7), chord(:a2, :sus4)]
# A slow, breathing pad: the valley before anyone has built anything.
in_thread do
  with_fx :reverb, room: 0.9, mix: 0.6 do
    with_fx :lpf, cutoff: 88 do
      use_synth :hollow
      2.times do
        prog.each do |c|
          play c, attack: 3, sustain: 2.5, release: 3, amp: 0.9
          sleep 8
        end
      end
    end
  end
end
# Soft roots underneath, one per chord.
in_thread do
  with_fx :lpf, cutoff: 70 do
    use_synth :sine
    2.times do
      prog.each do |c|
        play c[0] - 12, attack: 0.8, sustain: 4, release: 3, amp: 0.35
        sleep 8
      end
    end
  end
end
# Piano, rising broken chords with room between them: a draughtsman thinking.
in_thread do
  with_fx :reverb, room: 0.8, mix: 0.45 do
    use_synth :piano
    2.times do
      prog.each_with_index do |c, i|
        up = [c[0] + 12, c[1] + 12, c[2] + 12, c[3] + 12]
        play up[0], amp: 0.17, hard: 0.25, vel: 0.4
        sleep 1
        play up[1], amp: 0.14, hard: 0.25, vel: 0.4
        sleep 1
        play up[2], amp: 0.14, hard: 0.25, vel: 0.4
        sleep 1.5
        play up[3], amp: 0.12, hard: 0.25, vel: 0.4
        sleep 2.5
        play up[2] + 12, amp: 0.1, hard: 0.2, vel: 0.35 if i.odd?
        sleep 2
      end
    end
  end
end
# Now and then a drop of water, high and far off.
in_thread do
  with_fx :reverb, room: 0.7, mix: 0.5 do
    use_synth :sine
    64.times do
      play rrand(86, 98), attack: 0.002, release: 0.08, amp: 0.06, pan: rrand(-0.8, 0.8) if one_in(4)
      sleep 1
    end
  end
end
