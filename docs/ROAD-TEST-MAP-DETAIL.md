# Road-test map detail candidate

Adds a versioned DMH2 national roadside point format with explicit UK crossing references (zebra, pelican, puffin, toucan, parallel and pegasus), generic signalled crossings and safe fallback for ambiguous tags. Source: https://wiki.openstreetmap.org/wiki/Crossings_in_the_United_Kingdom . Generic or striped markings do not prove legal crossing type. Static locations do not prove real-world operation, direction or completeness.

Uses the existing immutable UK PBF source and compiler, with an expanded bounded Cheadle/Stockport regional geometry extract. Existing Android byte, tile and graph bounds are unchanged; reject the candidate if they fail. National building data already exists in the master source but the high-zoom nationwide rendering service remains unverified; this is not a nationwide tile publication. No route graph promotion, source pin substitution or data fabrication.

This focused branch incorporates only the previously pinned roadside compiler and preparation changes required for the Android paired candidate. The wider map service work in PR #23 remains separate. Android CI must validate the exact commit pin, generated files, regional geometry and display.
