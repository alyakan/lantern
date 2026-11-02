Pod::Spec.new do |s|
  s.name           = 'ComposerKeys'
  s.version        = '1.0.0'
  s.summary        = "Return on an iPad's hardware keyboard sends the message; Shift+Return stays a new line."
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Lantern'
  s.homepage       = 'https://github.com/alyakan/lantern'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/alyakan/lantern.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
