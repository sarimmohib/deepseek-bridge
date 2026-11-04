# Keep kotlinx.serialization generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keep,includedescriptorclasses class dev.sarim.dsbmobile.**$$serializer { *; }
-keepclassmembers class dev.sarim.dsbmobile.** {
    *** Companion;
}
-keepclasseswithmembers class dev.sarim.dsbmobile.** {
    kotlinx.serialization.KSerializer serializer(...);
}
