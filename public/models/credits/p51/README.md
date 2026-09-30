North American Aviation P-51D-25-NA
===================================

This is a model of the North American Aviation P-51D-25-NA for FlightGear made
by Hal Van Engel.

Development git repository can be found at [url-gh-p51d]

New features
------------

* Thunder sounds

* Can be damaged by missiles

* OPRF combat system for bullets, rockets, and bombs

* Fixed bomb release ordering and require arming for explosion animation

* TODO Fixed set combat tanks level to zero when they are dropped

* Use HD model of rocket for submodels with ALS flame effect and thicker smoke

* Zoom in or out using mouse scrollwheel, up to a distance of 300 meters

* Reset cockpit view with Shift + Q, move closer to gunsight with Ctrl + Q

* ALS procedural lights for position lights and landing light

* Exterior glass reflection

* ALS glass effect for rain

* ALS interior shadow

* TODO ALS exterior shadow

* Engine fire when engine fails

* Spark effect when fuselage or wings make contact with the ground

* Replaced hotspots with knob animations and added tooltips

* Made animation of cockpit controls smooth instead of instant

* Various auto pilots:

    - Heading hold using rudder (F6)

    - Wing leveler + V/S hold (F7)

    - Automatic takeoff (F8)

* Fixed remote compass indicator and turn coordinator

* Fixed the spinner making some objects behind it transparent

* Animate blade angle of propeller

* Added pitot tube cover and tie-downs

* TODO Wheel chocks

* Improved check lists

* Implemented coolant and oil radiator controls

* Implemented parking brakes (pull lever and tap brakes)

* Implemented vacuum system and fixed suction gage

* TODO Implemented climate control

* TODO Implemented oxygen system

* TODO Implemented hydraulics

* TODO Implemented electrical system

* TODO Implemented rear radar warning receiver

* TODO Implemented carb heat system to prevent ice near induction air duct

* TODO Crash detection: coolant fluid leak

* TODO Fuel boost pumps needed for sufficient fuel flow above 8500 ft

* TODO External fuel tanks need vacuum pressure for fuel flow

* TODO Improved guard switches of coolant and oil radiator controls

* TODO Added wing fuel tank gages on floor

* TODO Added windshield defroster, hot and cold air control on floor

* TODO Added fuselage fuel tank + tank level gage in cockpit

* TODO Added radio's on top of fuselage tank

* TODO Implemented fluorescent lights

* TODO Added gun camera + door in left wing

* TODO Added hydraulic accumulator in right wing

* TODO Added gun doors in both wings

* TODO Made throttle control smooth

Authors
=======

2003
----
The original model with YASim FDM was created around 2003 by Jim Wilson.

2010
----

Between 2010 and 2014 Hal Van Engel ([passed away in 2015][url-forum-engel])
greatly improved the model by improving the JSBSim FDM (in collaboration with
Jon S. Berndt) and systems, and creating new high quality 3D models of
the cockpit and the exterior, turning the P-51D model into one of the
most wonderful and sophisticated models available for FlightGear.
Viewed from the FlightGear community, this aircraft was his "kid".

2015
----
Autostart implemented by githlar and some minor FDM modifications by
Daniel Dubreuil (@dany93).

Flying hints
============

For more information or the USAAF manual, see the [FlightGear wiki][url-wiki-p51d].

Starting the engine
-------------------

1. Set propeller control to full INCREASE.
2. Ignition switch and battery-disconnect (second switch, top row of electrical
   box to pilots right) OFF.
3. Mixture to IDLE CUTOFF. (In FG /controls/engines/engine/mixture less than 0.1)
4. Have ground crew pull propeller through several revolutions.  (not modeled).
5. Fuel Cut Off valve ON.
6. External power supply connected. (Battery-disconnect switch ON if external
   power supply not available.)
7. Check throttle open approximately one inch (1500 rpm). (To start position on
   late airplanes.) (In FG /controls/engines/engine/throttle between 0.14 and 0.18)
   Messages will be diplayed telling you if the throttle is in the correct position
   for starting the engine.
8. Oil and coolant radiator air controls switches at OPEN until flaps are fully
   opened; then release switches to OFF. (not yet modeled.)
9. Check propeller is clear.
10. Hold start switch ON.
11. Ignition switch to BOTH after 6 blades have passed.
12. Fuel boost switch to ON.
13. Primer switch ON 3 or 4 seconds when cold, one second when hot.
14. When engine starts, move mixture control to RUN and release primer switch as
    engine smooths out.  Do not jockey throttle. If engine does not start after
    turning several revolutions, continue priming.
15. Check oil pressure. If it is not at 50 psi within 30 seconds after engine
    starts, stop engine and investigate.
16. Move battery-disconnect to ON after disconnecting external power supply.

Preflight airplane check
------------------------

1. Primary Controls:
   Check surfaces for free movement.
2. Instruments and Switches:
   Altimeter set.
   Directional gyro set.
   All instrument readings in desired ranges.
   All switches and controls in desired positions.
3. Fuel System:
   Check fuel tank selector handle on MAIN TANK L. H.  Be sure selector is in
detent.
   Fuel boost pump switch at ON.
   Primer switch OFF.
4. Flaps:
   Flaps set for take-off (up for normal take-off).
5. Trim:
   Trim tabs set for take-off:
      FUSELAGE TANK 0 to 25 GAL
         Rudder 6 degrees right
         Elevator 0 degrees
         Aileron 0 degrees

      FUSELAGE TANK FULL (65 gal. operational limit)
         Rudder 6 degrees right
         Elevator 2 to 4 degrees nose-heavy
         Aileron 0 degrees
6. Check all circuit breakers in.
7. Check that cockpit enclosure in locked and that canopy emergency release
handle is safetied.

Preflight engine check
----------------------

1. Check propeller in full INCREASE.
2. Power check - advance throttle to obtain 2300 rpm.  At this rpm, the manifold
   pressure should read 1/2 in. Hg less than field barometric pressure within +-1/2
   in Hg.
3. Ignition system check - at 2300 rpm, with propeller in full INCREASE, move
   ignition switch from BOTH to L, back to BOTH, then to R, and back to BOTH.  Let
   engine speed stabilize at BOTH between checks.  A maximum drop of 100 rpm is
   allowable for right magneto and 120 rpm for the left magneto.
4. Idle speed check - idle engine at 650 to 700 rpm with throttle at idle stop.
5. Acceleration and deceleration check - with mixture control at RUN,  advance
   throttle from idle to 2300 rpm.  Engine should accelerate and decelerate
   smoothly with not tendency to backfire.
6. Set throttle for 1500 rpm for best cooling during prolonged ground
   operations.
7. Carburetor ram-air control lever to RAM AIR. (UN-RAMMED FILTERED AIR or
   carburetor hot-air control lever at HOT_AIR only if required.) (not currently
   modeled.)
8. Check mixture control at RUN.
9. Check supercharger control switch at AUTO.
10. Oil and coolant radiators air controls switches at AUTOMATIC.

Take off
--------

1. Slowly increase throttle to 61 inHG Manifold Pressure as you pick up speed.
2. Be ready to actuate rudder during the take off roll.
3. At about 60 MPH indicated the tail will start to lift and the airplane will
   want to go to the left as the tail is coming up.  It is best to hold the tail 
   down until you have enough speed that the rudder controls the direction of the 
   aircraft.  So hold back pressure on the stick until you are at least up to 55
   MPH indicated.
4. As you gain speed the amount of rudder correction to the right will need to
   be decreased and you may need to use left rudder depending on how much right
   rudder trim you set.
5. Stay on top of rudder and elevator with small adjustments and keep the nose
   down until rotation or you'll do a ground loop.
6. Rotate at 150 mph if you have enough room but never below 120 mph (short
   field only).
7. As you raise the gear the trim will change in a nose up direction.  Be
   careful to avoid stalling or loosing air speed as the gear is retracted.
8. All of the take off trim settings will need to be adjusted as you pick up
   speed so this will contribute to a high pilot work load during the take off. 
   You will need to remove right rudder trim almost as soon as you leave the
   ground.

Climb
-----

1. Back off manifold pressure to 46 inHG.
2. Adjust propeller pitch to 2700 rpm.
3. The throttle has automatic boost controls and will hold the manifold pressure
setting as long as the supercharger has enough boost to provide the selected
setting.  It will hold 46 inHg to about 30,000 feet.
4. The mixture control is also automatic if it is set in the RUN position.
5. If the supercharger speed switch is at AUTOMATIC the supercharger gear ratio
will be controled by an automatic system.

Flying
------

1. Trim and Cruise at between 2100 and 2400 rpm with between 30 and 36 inHg
   manifold pressure.
2. Do not exceed 2700 rpm or 46 inHg sustained.
3. Do not exceed 3000 rpm military power (aerobatics)
4. Do not exceed 3500 rpm in dives.
5. Do not exceed 61 inHG Manifold Pressure (military power), except 75 inHG for
   maximum of 7 minutes (war emergency power).Note that war emergency power is not
   for flying fast,  rather it is for dogfighting at 200mph.

Pre traffic pattern check
-------------------------

1. Fuel tank selector handle on fullest internal tank.
2. Check that fuel booster pump switch is ON.
3. Check carburetor RAM and HOT-AIR control levers as needed.
4. Mixture control at RUN.
5. Propeller set at 2700 rpm.
6. Oil and coolant radiator air control switch AUTOMATIC.
7. Clean out engine at 3000 rpm and 61 in Hg for one minute.

Traffic pattern check
---------------------

1. Landing gear handle DN below 170 MPH IAS.
2. Check gear position by use of warning lights, horn and hydraulic pressure.
3. Flaps down 15 degrees for steeper approach if desired.
4. Recheck gear and flaps.
5. Throttle closed when landing assured.
6. Flaps full down at altitude of at least 400 feet.  (Below 165 MPH IAS.)
7. 120 IAS at edge of field.

Landing
-------

1. Use continuous back pressure on the stick to obtain an tail-low attitude for
   actual touch down.
2. Because of the wide landing gear and locked tail wheel, landing
   characteristics are excellent on this aircraft.
3. Minimize use of brakes during ground roll to avoid groud loops.
4. At completion of the landing roll, clear runway as soon as possible. 
   Excessive braking can cause you to do a ground loop (nose over).  Some recommend
   raising flaps immediately after touchdown.

Performance
-----------

This information is gleaned from various sources:

Maximum Speed: 437 mph
Cruise Speed: 363 mph
Landing Speed: 100 mph
Initial Climb Rate: 3475 feet per minute
Sustained Climb Speed: 175 mph
Service Ceiling: 41,200
Stall Speed (9000lbs) Gear/Flaps Up: 102mph Gear/Flaps Down: 95mph

Keyboard
--------

Ctrl-D is mapped to the second trigger on top of the stick.  This can be used to 
drop bombs, drop tanks and to fire rockets depending on how the weapons system 
related switches on the panel are set.  If you wish to use a joystick button 
for this (recommended) then you will need to do something like this in your joystick 
xml file:

```xml
<button n="<your joystick button number>">
    <desc>Fire Rockets or Release Bombs/Drop Tanks</desc>
    <repeatable>false</repeatable>
        <binding>
            <command>nasal</command>
            <script>setprop("/controls/armament/trigger2", 1)</script>
        </binding>
    <mod-up>
        <binding>
            <command>nasal</command>
            <script>setprop("/controls/armament/trigger2", 0)</script>
        </binding>
    </mod-up>
</button>
```

You will need to change <your joystick button number> to the correct number for the button 
you want to use.  On the P-51D this was the button on the top of the stick so it is 
recommended that you map this to a joystick button that is under your thumb to simulate the 
real controls.

  [url-gh-p51d]: https://github.com/onox/p51d
  [url-sf-fgaddon-p51d]: https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/p51d/
  [url-bfg]: http://rtyley.github.io/bfg-repo-cleaner/
  [url-wiki-p51d]: http://wiki.flightgear.org/North_American_P-51_Mustang
  [url-forum-engel]: https://forum.flightgear.org/viewtopic.php?f=4&t=28279#p268713
